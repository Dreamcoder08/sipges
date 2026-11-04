package http_test

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/identity/infrastructure"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/indicators/domain"
)

// The writes POST /system/irsa/config and /system/irsa/snapshot against the migrated synthetic
// PostgreSQL, through the composed handler: session, Origin, role gate, project scope (also a
// body naming another project), the tenant transaction and row-level security. They write into
// a project of their own, so the read tests' rows stay as seeded.

const writeTenant = "SIPGES/PRJ-ESCRITURA"

var writersOnce sync.Once

// writers seeds the project and three accounts that hold only it: an administrator, an analyst
// and a read-only account.
func writers(t *testing.T) {
	t.Helper()
	writersOnce.Do(func() {
		conn, err := pgx.Connect(t.Context(), scratch.URL)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = conn.Close(context.Background()) }()
		if _, err := conn.Exec(t.Context(), `
			INSERT INTO tenants (company_id, project_id, label) VALUES ('SIPGES','PRJ-ESCRITURA','Escritura');
			INSERT INTO users (username, full_name, password_hash, role, active, totp_enabled) VALUES
			  ('w-admin', 'Write Admin', 'x', 'admin', true, true),
			  ('w-analyst', 'Write Analyst', 'x', 'analista', true, true),
			  ('w-reader', 'Write Reader', 'x', 'consulta', true, true);
			INSERT INTO grants (username, tenant_id) VALUES
			  ('w-admin','SIPGES/PRJ-ESCRITURA'), ('w-analyst','SIPGES/PRJ-ESCRITURA'), ('w-reader','SIPGES/PRJ-ESCRITURA');`); err != nil {
			t.Fatal(err)
		}
		for _, user := range []string{"w-admin", "w-analyst", "w-reader"} {
			var b [32]byte
			_, _ = rand.Read(b[:])
			tokens[user] = hex.EncodeToString(b[:])
			if _, err := conn.Exec(t.Context(), `INSERT INTO sessions (token_hash, username, expires_at) VALUES ($1, $2, $3)`,
				infrastructure.HashToken(tokens[user]), user, t0.Add(8*time.Hour)); err != nil {
				t.Fatal(err)
			}
		}
	})
}

func post(t *testing.T, base, path, user, body string, headers map[string]string) (int, string) {
	t.Helper()
	r, err := http.NewRequestWithContext(t.Context(), http.MethodPost, base+path, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Origin", base)
	if user != "" {
		r.Header.Set("Cookie", "sipges_session="+tokens[user])
	}
	for k, v := range headers {
		if v == "" {
			r.Header.Del(k)
		} else {
			r.Header.Set(k, v)
		}
	}
	res, err := http.DefaultClient.Do(r)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = res.Body.Close() }()
	b, _ := io.ReadAll(res.Body)
	return res.StatusCode, strings.TrimSpace(string(b))
}

// stored reads a tenant's rows as the owner (row-level security does not apply).
func stored(t *testing.T, sql string, args ...any) []string {
	t.Helper()
	conn, err := pgx.Connect(t.Context(), scratch.URL)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = conn.Close(context.Background()) }()
	rows, err := conn.Query(t.Context(), sql, args...)
	if err != nil {
		t.Fatal(err)
	}
	out, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func TestUpdatesTheConfigurationOfTheResolvedProject(t *testing.T) {
	base := start(t)
	writers(t)
	norteBefore := stored(t, `SELECT config::text || updated_at::text FROM irsa_configs WHERE tenant_id = 'ACME/NORTE'`)

	// No row yet: the defaults are patched. The weights keep the dimensions' order, the bands
	// their own (array-index keys first, as JavaScript enumerates them).
	body := `{"payload":{"weights":{"I":0.5,"G":0.5},"thresholds":{"Alto":[50,100],"2":[0,49.99]},"contributions":{"nuevo":1}}}`
	status, answer := post(t, base, "/system/irsa/config", "w-admin", body, nil)
	if status != http.StatusOK || !strings.HasPrefix(answer, `{"ok":true,"config":{`) {
		t.Fatalf("%d %s", status, answer)
	}
	config := strings.TrimSuffix(strings.TrimPrefix(answer, `{"ok":true,"config":`), "}")
	if !strings.Contains(config, `"weights":{"G":0.5,"A":0,"D":0,"N":0,"E":0,"I":0.5}`) ||
		!strings.Contains(config, `"thresholds":{"2":[0,49.99],"Alto":[50,100]}`) ||
		!strings.Contains(config, `,"nuevo":1},`) {
		t.Fatalf("config %s", config)
	}
	// The json column keeps the answer's exact bytes; GET serves them; the audit row is the
	// tenant's own.
	if got := stored(t, `SELECT config::text FROM irsa_configs WHERE tenant_id = $1`, writeTenant); len(got) != 1 || got[0] != config {
		t.Fatalf("stored %v, want %s", got, config)
	}
	status, read := get(t, base, "/system/irsa/config", "w-reader", nil)
	expect(t, status, read, http.StatusOK, config)
	audit := stored(t, `SELECT concat_ws('|', ts::text, module, coalesce(record_id, '-'), action, detail) FROM audit WHERE tenant_id = $1 ORDER BY id`, writeTenant)
	if len(audit) != 1 || audit[0] != "2026-11-03 11:00:00+00|IRSA|-|CONFIG_UPDATE|Parámetros IRSA actualizados" {
		t.Fatalf("audit %v", audit)
	}

	// The same request again: the same configuration, one more audit row.
	status, again := post(t, base, "/system/irsa/config", "w-admin", body, nil)
	expect(t, status, again, http.StatusOK, answer)
	if got := stored(t, `SELECT count(*)::text FROM audit WHERE tenant_id = $1`, writeTenant); got[0] != "2" {
		t.Fatalf("audit rows %v", got)
	}

	// Weights outside the tolerance change nothing.
	status, rejected := post(t, base, "/system/irsa/config", "w-admin", `{"payload":{"weights":{"G":0.9}}}`, nil)
	expect(t, status, rejected, http.StatusBadRequest, `{"detail":"Los pesos deben sumar aproximadamente 1."}`)
	status, invalid := post(t, base, "/system/irsa/config", "w-admin", `{"payload":{"weights":{"G":"1"}}}`, nil)
	expect(t, status, invalid, http.StatusUnprocessableEntity,
		`{"detail":[{"type":"invalid_type","loc":["body","payload","weights","G"],"msg":"Invalid input: expected number, received string"}]}`)
	if got := stored(t, `SELECT config::text FROM irsa_configs WHERE tenant_id = $1`, writeTenant); got[0] != config {
		t.Fatalf("a refused write changed the configuration: %s", got[0])
	}
	if got := stored(t, `SELECT count(*)::text FROM audit WHERE tenant_id = $1`, writeTenant); got[0] != "2" {
		t.Fatalf("audit rows %v", got)
	}

	// Gates: no session, no Origin, an analyst or read-only account, another project.
	for _, c := range []struct {
		user    string
		headers map[string]string
		body    string
		status  int
		answer  string
	}{
		{"", nil, body, http.StatusUnauthorized, signIn},
		{"w-admin", map[string]string{"Origin": ""}, body, http.StatusForbidden, `{"detail":"Origen de solicitud no permitido"}`},
		{"w-analyst", nil, body, http.StatusForbidden, `{"detail":"Requiere rol administrador"}`},
		{"w-reader", nil, body, http.StatusForbidden, `{"detail":"Requiere rol administrador"}`},
		{"w-admin", map[string]string{"X-SIPGES-Scope": "ACME/NORTE"}, body, http.StatusForbidden,
			`{"detail":"Seleccione un proyecto autorizado mediante X-SIPGES-Scope o /select-project","projects":["SIPGES/PRJ-ESCRITURA"]}`},
		{"w-admin", nil, `{"project_id":"ACME/NORTE","payload":{"weights":{"E":1}}}`, http.StatusForbidden,
			`{"detail":"No se permite escribir en otro proyecto"}`},
		{"w-admin", nil, `{"payload":{"weights":{"E":1},"project_id":"ACME/NORTE"}}`, http.StatusForbidden,
			`{"detail":"No se permite escribir en otro proyecto"}`},
	} {
		status, got := post(t, base, "/system/irsa/config", c.user, c.body, c.headers)
		expect(t, status, got, c.status, c.answer)
	}
	if got := stored(t, `SELECT config::text FROM irsa_configs WHERE tenant_id = $1`, writeTenant); got[0] != config {
		t.Fatalf("a refused write changed the configuration: %s", got[0])
	}
	if got := stored(t, `SELECT config::text || updated_at::text FROM irsa_configs WHERE tenant_id = 'ACME/NORTE'`); got[0] != norteBefore[0] {
		t.Fatalf("another tenant's configuration changed: %s", got[0])
	}
}

func TestSavesSnapshotsOfTheResolvedProject(t *testing.T) {
	base := start(t)
	writers(t)
	status, irsa := get(t, base, "/system/irsa", "w-analyst", nil)
	if status != http.StatusOK {
		t.Fatalf("%d %s", status, irsa)
	}
	before := stored(t, `SELECT count(*)::text FROM irsa_snapshots`)

	// An analyst may save one; the answer is {ok, id, ...the IRSA}.
	var ids []string
	for range 2 {
		status, answer := post(t, base, "/system/irsa/snapshot", "w-analyst", `{"payload":{"note":"Corte sintético"}}`, nil)
		if status != http.StatusOK {
			t.Fatalf("%d %s", status, answer)
		}
		rest, found := strings.CutPrefix(answer, `{"ok":true,"id":`)
		id, tail, _ := strings.Cut(rest, ",")
		if !found || "{"+tail != irsa {
			t.Fatalf("answer %s\nirsa   %s", answer, irsa)
		}
		ids = append(ids, id)
	}
	if ids[0] == ids[1] {
		t.Fatalf("a repeated snapshot reused id %s", ids[0])
	}
	var result struct {
		Irsa   json.Number     `json:"irsa"`
		Level  string          `json:"level"`
		Scores json.RawMessage `json:"scores"`
	}
	if err := json.Unmarshal([]byte(irsa), &result); err != nil {
		t.Fatal(err)
	}
	rows := stored(t, `SELECT concat_ws('|', id, ts::text, irsa, level, scores::text, config_version, note) FROM irsa_snapshots WHERE tenant_id = $1 ORDER BY id`, writeTenant)
	want := "|2026-11-03 11:00:00+00|" + result.Irsa.String() + "|" + result.Level + "|" + string(result.Scores) + "|0.4-indicators|Corte sintético"
	if len(rows) != 2 || rows[0] != ids[0]+want || rows[1] != ids[1]+want {
		t.Fatalf("rows %v, want ids %v and %s", rows, ids, want)
	}
	value, _ := result.Irsa.Float64()
	detail := "|SNAPSHOT|Corte IRSA guardado: " + domain.PyFloat(value) + " " + result.Level
	audit := stored(t, `SELECT concat_ws('|', record_id, action, detail) FROM audit WHERE tenant_id = $1 AND action = 'SNAPSHOT' ORDER BY id`, writeTenant)
	if len(audit) != 2 || audit[0] != ids[0]+detail || audit[1] != ids[1]+detail {
		t.Fatalf("audit %v", audit)
	}
	status, history := get(t, base, "/system/irsa/history?limit=1", "w-reader", nil)
	expect(t, status, history, http.StatusOK,
		`[{"id":`+ids[1]+`,"ts":"2026-11-03T11:00:00Z","irsa":`+result.Irsa.String()+`,"level":"`+result.Level+`","scores":`+string(result.Scores)+`,"config_version":"0.4-indicators","note":"Corte sintético"}]`)

	for _, c := range []struct {
		user    string
		headers map[string]string
		body    string
		status  int
		answer  string
	}{
		{"", nil, `{"payload":{}}`, http.StatusUnauthorized, signIn},
		{"w-reader", nil, `{"payload":{}}`, http.StatusForbidden, `{"detail":"Rol de consulta: solo lectura"}`},
		{"w-analyst", map[string]string{"Origin": ""}, `{"payload":{}}`, http.StatusForbidden, `{"detail":"Origen de solicitud no permitido"}`},
		{"w-analyst", nil, `{"payload":{"project_id":"ACME/NORTE"}}`, http.StatusForbidden, `{"detail":"No se permite escribir en otro proyecto"}`},
		{"w-analyst", map[string]string{"X-SIPGES-Scope": "ACME/NORTE"}, `{"payload":{}}`, http.StatusForbidden,
			`{"detail":"Seleccione un proyecto autorizado mediante X-SIPGES-Scope o /select-project","projects":["SIPGES/PRJ-ESCRITURA"]}`},
		{"w-analyst", nil, `{"payload":{"note":"a\u0000"}}`, http.StatusUnprocessableEntity,
			`{"detail":[{"type":"custom","loc":["body","payload"],"msg":"Text must not contain NUL characters"}]}`},
		{"w-analyst", nil, `{`, http.StatusUnprocessableEntity, `{"detail":[{"type":"json_invalid","loc":["body"],"msg":"JSON decode error"}]}`},
	} {
		status, got := post(t, base, "/system/irsa/snapshot", c.user, c.body, c.headers)
		expect(t, status, got, c.status, c.answer)
	}
	after := stored(t, `SELECT count(*)::text FROM irsa_snapshots`)
	if before[0] == after[0] || stored(t, `SELECT count(*)::text FROM irsa_snapshots WHERE tenant_id <> $1 AND note = 'Corte sintético'`, writeTenant)[0] != "0" {
		t.Fatalf("snapshots before %s after %s, or one landed in another tenant", before[0], after[0])
	}
}
