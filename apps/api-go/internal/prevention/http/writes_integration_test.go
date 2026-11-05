package http_test

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/identity/infrastructure"
)

// The prevention writes against a migrated synthetic PostgreSQL, through the composed handler.
// The JSON and every validation are checked against the TypeScript routes by
// writes_fixtures_test.go and the parity runner; these tests pin what reaches the tables, tenant
// isolation and the gates. They own the WRITE tenants, so the read tests' rows stay as seeded.

const (
	writeTenant = "WRITE/PRJ-W"
	otherTenant = "WRITE/PRJ-OTRO"
	actionsPath = "/system/prevention/actions"
)

var writeSeed struct {
	once sync.Once
	err  error
}

func attachment(tenant, project, id string) string {
	return fmt.Sprintf(`INSERT INTO module_records (tenant_id, module, id, payload, created_at, updated_at, marking)
		VALUES ('%[1]s', 'Alertas', 'X', '{}', '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z', 'interno');
		INSERT INTO attachments (tenant_id, id, storage_key, original_name, content_type,
		size_bytes, sha256, linked_module, record_module, linked_record_id, document_type, author,
		verification, notes, project_id, project_name, created_at) VALUES
		('%[1]s', '%[2]s', '%[1]s/%[2]s', 'acta.pdf', 'application/pdf', 1, '%[3]s', 'alertas', 'Alertas',
		 'X', 'Acta', 'Equipo', 'E - No verificada', '', '%[4]s', 'P', '2026-10-01T00:00:00Z');`,
		tenant, id, sha, project)
}

func plan(tenant, project, id, status string) string {
	return fmt.Sprintf(`INSERT INTO preventive_actions (tenant_id, id, project_id, alert_id, title, responsible,
		due_date, description, status, progress, created_at, updated_at) VALUES
		('%s', '%s', '%s', 'ALERT-W', 'Plan sintético', 'Equipo', '2099-01-01', '', '%s', 0,
		 '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z');`, tenant, id, project, status)
}

// seedWrites adds the write tenants once. ALERT-W exists in both, so only
// row-level security keeps them apart.
func seedWrites(t *testing.T) {
	t.Helper()
	if scratch == nil {
		t.Skip("no scratch database")
	}
	writeSeed.once.Do(func() {
		ctx := context.Background()
		conn, err := pgx.Connect(ctx, scratch.URL)
		if err != nil {
			writeSeed.err = err
			return
		}
		defer func() { _ = conn.Close(ctx) }()
		if _, err := conn.Exec(ctx, `
			INSERT INTO tenants (company_id, project_id, label) VALUES
			  ('WRITE','PRJ-W','Escritura'), ('WRITE','PRJ-OTRO','Otra');
			INSERT INTO users (username, full_name, password_hash, role, active, totp_enabled) VALUES
			  ('wanalyst', 'Analista W',  'x', 'analista',    true, true),
			  ('wcoord',   'Coordina W',  'x', 'coordinador', true, true),
			  ('wreader',  'Consulta W',  'x', 'consulta',    true, true),
			  ('wboth',    'Dos W',       'x', 'analista',    true, true);
			INSERT INTO grants (username, tenant_id) VALUES
			  ('wanalyst','WRITE/PRJ-W'), ('wcoord','WRITE/PRJ-W'), ('wreader','WRITE/PRJ-W'),
			  ('wboth','WRITE/PRJ-W'), ('wboth','WRITE/PRJ-OTRO');`); err != nil {
			writeSeed.err = err
			return
		}
		own := alert(writeTenant, "PRJ-W", "ALERT-W") + alert(writeTenant, "PRJ-AJENO", "ALERT-AJENO") +
			`UPDATE digital_alert_reviews SET status = 'Pendiente de verificación' WHERE id = 'ALERT-AJENO';` +
			alert(writeTenant, "PRJ-W", "ALERT-NUEVA") +
			`UPDATE digital_alert_reviews SET status = 'Descartado' WHERE id = 'ALERT-NUEVA';` +
			plan(writeTenant, "PRJ-W", "PREV-W", "Pendiente") + plan(writeTenant, "PRJ-W", "PREV-BLOCK", "En ejecución") +
			plan(writeTenant, "PRJ-W", "PREV-CLOSE", "En ejecución") + plan(writeTenant, "PRJ-W", "PREV-GONE", "Cancelada") +
			plan(writeTenant, "PRJ-W", "PREV-REFUSE", "En ejecución") +
			attachment(writeTenant, "PRJ-W", "EV-W")
		if err := tenantRows(ctx, conn, writeTenant, own); err != nil {
			writeSeed.err = err
			return
		}
		other := alert(otherTenant, "PRJ-OTRO", "ALERT-OTRO") + alert(otherTenant, "PRJ-OTRO", "ALERT-W") + plan(otherTenant, "PRJ-OTRO", "PREV-OTRO", "Pendiente") +
			attachment(otherTenant, "PRJ-OTRO", "EV-OTRO")
		if err := tenantRows(ctx, conn, otherTenant, other); err != nil {
			writeSeed.err = err
			return
		}
		batch := &pgx.Batch{}
		for _, user := range []string{"wanalyst", "wcoord", "wreader", "wboth"} {
			var b [32]byte
			_, _ = rand.Read(b[:])
			tokens[user] = hex.EncodeToString(b[:])
			batch.Queue(`INSERT INTO sessions (token_hash, username, expires_at) VALUES ($1, $2, $3)`,
				infrastructure.HashToken(tokens[user]), user, t0.Add(8*time.Hour))
		}
		writeSeed.err = conn.SendBatch(ctx, batch).Close()
	})
	if writeSeed.err != nil {
		t.Fatal(writeSeed.err)
	}
}

// send makes a same-origin write (Origin is the test server).
func send(t *testing.T, base, method, path, user, body string, headers map[string]string) (int, string) {
	t.Helper()
	r, err := http.NewRequestWithContext(t.Context(), method, base+path, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	r.Header.Set("Origin", base)
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Cookie", "sipges_session="+tokens[user])
	for k, v := range headers {
		r.Header.Set(k, v)
	}
	res, err := http.DefaultClient.Do(r)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = res.Body.Close() }()
	b, _ := io.ReadAll(res.Body)
	return res.StatusCode, strings.TrimSpace(string(b))
}

// count reads one number as the superuser, past row-level security.
func count(t *testing.T, sql string, args ...any) int {
	t.Helper()
	conn, err := pgx.Connect(t.Context(), scratch.URL)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = conn.Close(context.Background()) }()
	var n int
	if err := conn.QueryRow(t.Context(), sql, args...).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

// text reads one text value as the superuser.
func text(t *testing.T, sql string, args ...any) string {
	t.Helper()
	conn, err := pgx.Connect(t.Context(), scratch.URL)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = conn.Close(context.Background()) }()
	var s string
	if err := conn.QueryRow(t.Context(), sql, args...).Scan(&s); err != nil {
		t.Fatal(err)
	}
	return s
}

func auditCount(t *testing.T, tenant, id string) int {
	t.Helper()
	return count(t, `SELECT count(*) FROM audit WHERE tenant_id = $1 AND record_id = $2`, tenant, id)
}

func TestCreatesAPlanWithItsLogAndAudit(t *testing.T) {
	seedWrites(t)
	base := start(t)
	body := `{"alert_id":"ALERT-W","title":"Plan nuevo","responsible":"Equipo","due_date":"2027-02-28","description":"Detalle 😀 \ud800"}`
	status, answer := send(t, base, http.MethodPost, actionsPath, "wcoord", body, nil)
	if status != http.StatusOK {
		t.Fatalf("got %d %s", status, answer)
	}
	var out struct {
		Action struct {
			ID, ProjectID, Status, Description, Title string
			History                                   []struct{ ID, Status, Note string }
		}
		IRSAModified *bool `json:"irsa_modified"`
	}
	if err := json.Unmarshal([]byte(answer), &out); err != nil {
		t.Fatal(err)
	}
	id := out.Action.ID
	if !strings.HasPrefix(id, "PREV-") || len(id) != 17 || id != strings.ToUpper(id) {
		t.Fatalf("id %q", id)
	}
	if out.IRSAModified == nil || *out.IRSAModified || out.Action.Status != "Pendiente" || out.Action.Description != "Detalle 😀 �" {
		t.Fatalf("answer %s", answer)
	}
	if len(out.Action.History) != 1 || out.Action.History[0].Note != "Plan creado" || len(out.Action.History[0].ID) != 32 ||
		out.Action.History[0].ID != strings.ToLower(out.Action.History[0].ID) {
		t.Fatalf("history %s", answer)
	}
	if got := text(t, `SELECT project_id || '|' || due_date || '|' || status || '|' || progress FROM preventive_actions
		WHERE tenant_id = $1 AND id = $2`, writeTenant, id); got != "PRJ-W|2027-02-28|Pendiente|0" {
		t.Fatalf("row %q", got)
	}
	if got := text(t, `SELECT module || '|' || action || '|' || detail || '|' || to_char(ts AT TIME ZONE 'UTC', 'YYYY-MM-DD') FROM audit
		WHERE tenant_id = $1 AND record_id = $2`, writeTenant, id); got != "PrevencionTerritorial|CREATE|ALERT-W|"+t0.Format("2006-01-02") {
		t.Fatalf("audit %q", got)
	}
	if n := count(t, `SELECT count(*) FROM preventive_action_log WHERE tenant_id = $1 AND action_id = $2 AND decided_by IS NULL
		AND evidence_url IS NULL`, writeTenant, id); n != 1 {
		t.Fatalf("log rows %d", n)
	}
}

func TestCreateFollowsOnlyVerifiedAlertsOfTheScope(t *testing.T) {
	seedWrites(t)
	base := start(t)
	before := count(t, `SELECT count(*) FROM preventive_actions`)
	for _, c := range []struct {
		name, alert string
		status      int
		detail      string
	}{
		{"unverified", "ALERT-NUEVA", http.StatusConflict, "La alerta necesita verificación antes de crear un plan"},
		{"another project in the tenant", "ALERT-AJENO", http.StatusNotFound, "Alerta no pertenece al proyecto indicado"},
		{"another tenant's alert", "ALERT-OTRO", http.StatusNotFound, "Alerta no pertenece al proyecto indicado"},
		{"no such alert", "ALERT-NADA", http.StatusNotFound, "Alerta no pertenece al proyecto indicado"},
	} {
		t.Run(c.name, func(t *testing.T) {
			body := fmt.Sprintf(`{"alert_id":%q,"title":"Plan nuevo","responsible":"Equipo","due_date":"2027-02-28"}`, c.alert)
			status, answer := send(t, base, http.MethodPost, actionsPath, "wanalyst", body, nil)
			expect(t, status, answer, c.status, fmt.Sprintf(`{"detail":%q}`, c.detail))
		})
	}
	if after := count(t, `SELECT count(*) FROM preventive_actions`); after != before {
		t.Fatalf("plans went from %d to %d", before, after)
	}
}

func TestUpdatesAPlanWithItsLogAndAudit(t *testing.T) {
	seedWrites(t)
	base := start(t)
	body := `{"status":"En ejecución","progress":30,"note":"Avance sintético","evidence_url":"https://example.org/a"}`
	status, answer := send(t, base, http.MethodPatch, actionsPath+"/PREV-W", "wanalyst", body, nil)
	if status != http.StatusOK {
		t.Fatalf("got %d %s", status, answer)
	}
	if got := text(t, `SELECT status || '|' || progress FROM preventive_actions WHERE tenant_id = $1 AND id = 'PREV-W'`, writeTenant); got != "En ejecución|30" {
		t.Fatalf("row %q", got)
	}
	if got := text(t, `SELECT status || '|' || progress || '|' || note || '|' || evidence_url || '|' || decided_by
		FROM preventive_action_log WHERE tenant_id = $1 AND action_id = 'PREV-W'`, writeTenant); got != "En ejecución|30|Avance sintético|https://example.org/a|wanalyst" {
		t.Fatalf("log %q", got)
	}
	if got := text(t, `SELECT action || '|' || detail FROM audit WHERE tenant_id = $1 AND record_id = 'PREV-W'`, writeTenant); got != "UPDATE|En ejecución: Avance sintético" {
		t.Fatalf("audit %q", got)
	}
}

func TestTheBlockerKeepsItsTimeWhileThePartyStaysAndClosingClearsIt(t *testing.T) {
	seedWrites(t)
	base := start(t)
	change := func(id, body string) {
		t.Helper()
		if status, answer := send(t, base, http.MethodPatch, actionsPath+"/"+id, "wanalyst", body, nil); status != http.StatusOK {
			t.Fatalf("got %d %s", status, answer)
		}
	}
	read := func(id string) string {
		t.Helper()
		return text(t, `SELECT coalesce(blocked_by, '-') || '|' || coalesce(blocked_reason, '-') || '|' ||
			coalesce(to_char(blocked_since AT TIME ZONE 'UTC', 'YYYY-MM-DD'), '-') FROM preventive_actions
			WHERE tenant_id = $1 AND id = $2`, writeTenant, id)
	}
	today := t0.Format("2006-01-02")
	change("PREV-BLOCK", `{"status":"En ejecución","progress":10,"blocked_by":" Comunidad ","blocked_reason":" Asamblea "}`)
	if got := read("PREV-BLOCK"); got != "Comunidad|Asamblea|"+today {
		t.Fatalf("blocked %q", got)
	}
	// An earlier start proves the same party keeps it and another party restarts it.
	conn, err := pgx.Connect(t.Context(), scratch.URL)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = conn.Close(context.Background()) }()
	if _, err := conn.Exec(t.Context(), `UPDATE preventive_actions SET blocked_since = '2026-01-02T00:00:00Z'
		WHERE tenant_id = $1 AND id = 'PREV-BLOCK'`, writeTenant); err != nil {
		t.Fatal(err)
	}
	change("PREV-BLOCK", `{"status":"En ejecución","progress":20,"blocked_by":"Comunidad","blocked_reason":"Otra"}`)
	if got := read("PREV-BLOCK"); got != "Comunidad|Otra|2026-01-02" {
		t.Fatalf("same party %q", got)
	}
	change("PREV-BLOCK", `{"status":"En ejecución","progress":25}`)
	if got := read("PREV-BLOCK"); got != "Comunidad|Otra|2026-01-02" {
		t.Fatalf("absent blocker %q", got)
	}
	change("PREV-BLOCK", `{"status":"En ejecución","progress":30,"blocked_by":"Autoridad"}`)
	if got := read("PREV-BLOCK"); got != "Autoridad||"+today {
		t.Fatalf("another party %q", got)
	}
	change("PREV-BLOCK", `{"status":"En ejecución","progress":35,"blocked_by":""}`)
	if got := read("PREV-BLOCK"); got != "-|-|-" {
		t.Fatalf("cleared %q", got)
	}
	change("PREV-CLOSE", `{"status":"En ejecución","progress":35,"blocked_by":"Otro"}`)
	change("PREV-CLOSE", `{"status":"Completada","progress":100,"note":"Cerrada","evidence_attachment_id":" EV-W "}`)
	if got := read("PREV-CLOSE"); got != "-|-|-" {
		t.Fatalf("closing %q", got)
	}
	if got := text(t, `SELECT evidence_attachment_id || '|' || evidence_file_name || '|' || evidence_sha256 FROM preventive_action_log
		WHERE tenant_id = $1 AND action_id = 'PREV-CLOSE' AND status = 'Completada'`, writeTenant); got != "EV-W|acta.pdf|"+sha {
		t.Fatalf("receipt %q", got)
	}
	if got := text(t, `SELECT detail FROM audit WHERE tenant_id = $1 AND record_id = 'PREV-CLOSE' AND detail LIKE 'Completada%'`, writeTenant); got != "Completada: Cerrada · sha256 "+sha[:12] {
		t.Fatalf("audit %q", got)
	}
}

func TestRefusedUpdatesWriteNothing(t *testing.T) {
	seedWrites(t)
	base := start(t)
	for _, c := range []struct {
		name, id, user, body string
		status               int
		detail               string
	}{
		{"another tenant's plan", "PREV-OTRO", "wanalyst", `{"status":"En ejecución","progress":10}`, http.StatusNotFound, "Acción no encontrada"},
		{"another tenant's evidence", "PREV-REFUSE", "wanalyst", `{"status":"Completada","progress":100,"note":"x","evidence_attachment_id":"EV-OTRO"}`, http.StatusNotFound, "Evidencia no encontrada en el proyecto"},
		{"a cancelled plan", "PREV-GONE", "wanalyst", `{"status":"En ejecución","progress":10}`, http.StatusConflict, "No puede reactivar una acción cancelada"},
		{"closing without a reason", "PREV-REFUSE", "wanalyst", `{"status":"Cancelada","progress":10,"note":"  "}`, http.StatusUnprocessableEntity, "Justifique el cierre o cancelación"},
		{"the read-only role", "PREV-REFUSE", "wreader", `{"status":"En ejecución","progress":10}`, http.StatusForbidden, "Rol de consulta: solo lectura"},
	} {
		t.Run(c.name, func(t *testing.T) {
			status, answer := send(t, base, http.MethodPatch, actionsPath+"/"+c.id, c.user, c.body, nil)
			expect(t, status, answer, c.status, fmt.Sprintf(`{"detail":%q}`, c.detail))
			for _, tenant := range []string{writeTenant, otherTenant} {
				if n := auditCount(t, tenant, c.id); n != 0 {
					t.Fatalf("%d audit rows", n)
				}
				if n := count(t, `SELECT count(*) FROM preventive_action_log WHERE tenant_id = $1 AND action_id = $2`, tenant, c.id); n != 0 {
					t.Fatalf("%d log rows", n)
				}
			}
		})
	}
	if got := text(t, `SELECT status FROM preventive_actions WHERE tenant_id = $1 AND id = 'PREV-OTRO'`, otherTenant); got != "Pendiente" {
		t.Fatalf("another tenant's plan is %q", got)
	}
}

func TestWritesRunInTheChosenProjectAndHonourTheGates(t *testing.T) {
	seedWrites(t)
	base := start(t)
	plan := `{"alert_id":"ALERT-OTRO","title":"Plan nuevo","responsible":"Equipo","due_date":"2027-02-28"}`
	// A two-project user reaches the other project's alert only by choosing that project.
	status, answer := send(t, base, http.MethodPost, actionsPath, "wboth", plan, map[string]string{"X-SIPGES-Scope": writeTenant})
	expect(t, status, answer, http.StatusNotFound, `{"detail":"Alerta no pertenece al proyecto indicado"}`)
	status, answer = send(t, base, http.MethodPost, actionsPath, "wboth", plan, map[string]string{"X-SIPGES-Scope": otherTenant})
	if status != http.StatusOK || !strings.Contains(answer, `"project_id":"PRJ-OTRO"`) {
		t.Fatalf("got %d %s", status, answer)
	}
	// A body naming another project is refused before the route.
	named := `{"project_id":"PRJ-OTRO","alert_id":"ALERT-W","title":"Plan nuevo","responsible":"Equipo","due_date":"2027-02-28"}`
	status, answer = send(t, base, http.MethodPost, actionsPath, "wanalyst", named, nil)
	expect(t, status, answer, http.StatusForbidden, `{"detail":"No se permite escribir en otro proyecto"}`)
	status, answer = send(t, base, http.MethodPost, actionsPath, "wreader", plan, nil)
	expect(t, status, answer, http.StatusForbidden, `{"detail":"Rol de consulta: solo lectura"}`)
	status, answer = send(t, base, http.MethodPost, actionsPath, "wanalyst", plan, map[string]string{"Origin": "https://ajeno.example"})
	expect(t, status, answer, http.StatusForbidden, `{"detail":"Origen de solicitud no permitido"}`)
}
