package http_test

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/identity/infrastructure"
)

// The intelligence write routes (POST /system/analyze, POST analyze-text, PATCH an alert)
// against the migrated synthetic database. They use a tenant of their own, WRITE/PRJ-W, so the
// read tests' alerts never change. Every account, project, record and alert is synthetic.

const writeTenant = "WRITE/PRJ-W"

var writeSeed struct {
	once sync.Once
	err  error
}

// writeAlerts are the alerts the decision tests change; each test owns its ids.
var writeAlerts = columns +
	alertRow(writeTenant, "PRJ-W", "W-MEDIA", "2026-10-01T00:00:00Z", "Media", "Pendiente de verificación", `[]`, "") + "," +
	alertRow(writeTenant, "PRJ-W", "W-ALTA-1", "2026-10-01T00:00:00Z", "Alta", "Pendiente de verificación", `[]`, "") + "," +
	alertRow(writeTenant, "PRJ-W", "W-ALTA-2", "2026-10-01T00:00:00Z", "Alta", "Pendiente de verificación", `[]`,
		`NULL, NULL, NULL, '{"module":"Narrativas","id":"NAR-9"}', 'wcolega'`) + "," + //nolint:misspell // Spanish module name
	alertRow(writeTenant, "PRJ-W", "W-ALTA-3", "2026-10-01T00:00:00Z", "Alta", "Pendiente de verificación", `[]`,
		`NULL, NULL, 'Ica', NULL, 'writer'`) + "," +
	alertRow(writeTenant, "PRJ-W", "W-ALTA-4", "2026-10-01T00:00:00Z", "Alta", "Pendiente de verificación", `[]`, "") + "," +
	// Same tenant, another project id: decisions answer 404 and leave it alone.
	alertRow(writeTenant, "PRJ-OTRO", "W-OTRO", "2026-10-01T00:00:00Z", "Media", "Pendiente de verificación", `[]`, "") + ";"

// fixtureNarratives are the narratives of engines/fixtures/text-analysis.json case text/parity-0,
// newest first.
const fixtureNarratives = `INSERT INTO module_records (tenant_id, module, id, payload, created_at, updated_at) VALUES
  ('WRITE/PRJ-W', 'Narrativas', 'NAR-1', '{"Tema":"Agua y contaminación","Descripcion":"Reclamo por polvo en la bahía","Proyecto_ID":"PRJ-SECHURA"}', '2026-10-03T00:00:00Z', '2026-10-03T00:00:00Z'),
  ('WRITE/PRJ-W', 'Narrativas', 'NAR-2', '{"Tema":"Empleo local","Descripcion":"Contratación de proveedores"}', '2026-10-02T00:00:00Z', '2026-10-02T00:00:00Z'),
  ('WRITE/PRJ-W', 'Narrativas', 'NAR-3', '{"Tema":null,"Descripcion":"Asamblea de la comunidad campesina sobre elección de directiva"}', '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z'),
  ('WRITE/PRJ-W', 'Demandas', 'DEM-1', '{"Tema":"No es narrativa","Descripcion":"paro"}', '2026-10-04T00:00:00Z', '2026-10-04T00:00:00Z');`

func seedWrites(t *testing.T) {
	t.Helper()
	if scratch == nil {
		t.Skip("integration database not configured")
	}
	writeSeed.once.Do(func() {
		ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
		defer cancel()
		conn, err := pgx.Connect(ctx, scratch.URL)
		if err != nil {
			writeSeed.err = err
			return
		}
		defer func() { _ = conn.Close(ctx) }()
		if _, err := conn.Exec(ctx, `
			INSERT INTO tenants (company_id, project_id, label) VALUES ('WRITE','PRJ-W','Escritura');
			INSERT INTO users (username, full_name, password_hash, role, active, totp_enabled) VALUES
			  ('writer',  'Analista W',  'x', 'analista',    true, true),
			  ('wcolega', 'Colega W',    'x', 'analista',    true, true),
			  ('wcoord',  'Coordina W',  'x', 'coordinador', true, true),
			  ('wreader', 'Consulta W',  'x', 'consulta',    true, true);
			INSERT INTO grants (username, tenant_id) VALUES
			  ('writer','WRITE/PRJ-W'), ('wcolega','WRITE/PRJ-W'), ('wcoord','WRITE/PRJ-W'), ('wreader','WRITE/PRJ-W');`); err != nil {
			writeSeed.err = err
			return
		}
		if err := tenantRows(ctx, conn, writeTenant, writeAlerts+fixtureNarratives); err != nil {
			writeSeed.err = err
			return
		}
		batch := &pgx.Batch{}
		for _, user := range []string{"writer", "wcolega", "wcoord", "wreader"} {
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

// send makes a same-origin write (Origin is the test server) unless headers override it.
func send(t *testing.T, base, method, path, user, body string, headers map[string]string) (int, string) {
	t.Helper()
	r, err := http.NewRequestWithContext(t.Context(), method, base+path, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	r.Header.Set("Origin", base)
	r.Header.Set("Content-Type", "application/json")
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
	if ct := res.Header.Get("Content-Type"); !strings.HasPrefix(ct, "application/json") {
		t.Fatalf("%s %s: content-type %q", method, path, ct)
	}
	return res.StatusCode, strings.TrimSpace(string(b))
}

func issue(kind, loc, msg string) string {
	return `{"type":"` + kind + `","loc":[` + loc + `],"msg":"` + msg + `"}`
}

func issues(items ...string) string { return `{"detail":[` + strings.Join(items, ",") + `]}` }

var (
	jsonInvalid = issues(issue("json_invalid", `"body"`, "JSON decode error"))
	readOnly    = `{"detail":"Rol de consulta: solo lectura"}`
	badOrigin   = `{"detail":"Origen de solicitud no permitido"}`
	otherWrite  = `{"detail":"No se permite escribir en otro proyecto"}`
)

// textFixtures are the TypeScript-recorded requests and values of the text engine.
func textFixtures(t *testing.T) map[string]struct{ request, value string } {
	t.Helper()
	raw, err := os.ReadFile("../../../../../engines/fixtures/text-analysis.json")
	if err != nil {
		t.Fatal(err)
	}
	var file struct {
		Cases []struct{ Name, Request, Value string } `json:"cases"`
	}
	if err := json.Unmarshal(raw, &file); err != nil {
		t.Fatal(err)
	}
	out := map[string]struct{ request, value string }{}
	for _, c := range file.Cases {
		out[c.Name] = struct{ request, value string }{c.Request, c.Value}
	}
	return out
}

func TestClassifyAnswersTheTypeScriptClassifier(t *testing.T) {
	seedWrites(t)
	srv := start(t)
	fixtures := textFixtures(t)
	for _, name := range []string{"classify/parity-0", "classify/parity-1", "classify/parity-5", "classify/parity-6"} {
		f := fixtures[name]
		// The fixture request is {"payload": …}: the route's body, byte for byte.
		code, body := send(t, srv, "POST", "/system/analyze", "writer", f.request, nil)
		expect(t, code, body, http.StatusOK, f.value)
		// The read-only role may classify: the route computes and stores nothing.
		code, body = send(t, srv, "POST", "/system/analyze", "wreader", f.request, nil)
		expect(t, code, body, http.StatusOK, f.value)
	}
}

func TestClassifyValidatesTheBody(t *testing.T) {
	seedWrites(t)
	srv := start(t)
	record := func(received string) string {
		return issues(issue("invalid_type", `"body","payload"`, "Invalid input: expected record, received "+received))
	}
	for _, c := range []struct {
		body   string
		status int
		want   string
	}{
		{``, 422, jsonInvalid},
		{`{`, 422, jsonInvalid},
		{`{} {}`, 422, jsonInvalid},
		{`{}`, 422, issues(issue("missing", `"body","payload"`, "Field required"))},
		{`[]`, 422, issues(issue("invalid_type", `"body"`, "Invalid input: expected object, received array"))},
		{`"x"`, 422, issues(issue("invalid_type", `"body"`, "Invalid input: expected object, received string"))},
		{`null`, 422, issues(issue("invalid_type", `"body"`, "Invalid input: expected object, received null"))},
		{`{"payload":[]}`, 422, record("array")},
		{`{"payload":null}`, 422, record("null")},
		{`{"payload":"x"}`, 422, record("string")},
		{`{"payload":1.5}`, 422, record("number")},
		{`{"payload":true}`, 422, record("boolean")},
		// The last duplicate key wins, as JSON.parse.
		{`{"payload":1,"payload":[]}`, 422, record("array")},
		// The project check of the tenancy middleware runs first.
		{`{"payload":{"Proyecto_ID":"OTRO"}}`, 403, otherWrite},
	} {
		code, body := send(t, srv, "POST", "/system/analyze", "writer", c.body, nil)
		expect(t, code, body, c.status, c.want)
	}
	code, body := send(t, srv, "POST", "/system/analyze", "", `{"payload":{}}`, nil)
	expect(t, code, body, http.StatusUnauthorized, signIn)
	code, body = send(t, srv, "POST", "/system/analyze", "writer", `{"payload":{}}`, map[string]string{"Origin": ""})
	expect(t, code, body, http.StatusForbidden, badOrigin)
}

func TestAnalyzeTextReadsTheProjectNarratives(t *testing.T) {
	seedWrites(t)
	srv := start(t)
	f := textFixtures(t)["text/parity-0"]
	var request struct {
		Text      string `json:"text"`
		SourceURL string `json:"source_url"`
	}
	if err := json.Unmarshal([]byte(f.request), &request); err != nil {
		t.Fatal(err)
	}
	var envelope struct {
		Value json.RawMessage `json:"value"`
	}
	if err := json.Unmarshal([]byte(f.value), &envelope); err != nil {
		t.Fatal(err)
	}
	// The fixture analysed project PRJ-SECHURA; this tenant's project is PRJ-W.
	want := strings.Replace(string(envelope.Value), `"project_id":"PRJ-SECHURA"`, `"project_id":"PRJ-W"`, 1)
	body, _ := json.Marshal(map[string]string{"text": request.Text, "source_url": request.SourceURL, "project_id": "PRJ-W"})
	code, got := send(t, srv, "POST", "/system/intelligence/analyze-text", "writer", string(body), nil)
	expect(t, code, got, http.StatusOK, want)

	// Another tenant's narratives never take part: SIPGES/PRJ-SECHURA has none.
	none, _ := json.Marshal(map[string]string{"text": request.Text, "source_url": request.SourceURL})
	code, got = send(t, srv, "POST", "/system/intelligence/analyze-text", "multi", string(none),
		map[string]string{"X-SIPGES-Scope": "SIPGES/PRJ-SECHURA"})
	if code != http.StatusOK || strings.Contains(got, "Reclamo por polvo") || strings.Contains(got, "Agua y contaminación") {
		t.Fatalf("narratives leaked across tenants: %d %s", code, got)
	}
}

func TestAnalyzeTextErrorsAndGates(t *testing.T) {
	seedWrites(t)
	srv := start(t)
	const path = "/system/intelligence/analyze-text"
	str := func(field, received string) string {
		return issue("invalid_type", `"body","`+field+`"`, "Invalid input: expected string, received "+received)
	}
	for _, c := range []struct {
		user, body string
		status     int
		want       string
	}{
		{"writer", `{"text":"   "}`, 422, `{"detail":"Ingrese el texto transcrito de la publicación."}`}, //nolint:misspell // Spanish, verbatim
		{"writer", `{"text":"` + strings.Repeat("a", 20001) + `"}`, 413, `{"detail":"Máximo 20 000 caracteres."}`},
		{"writer", `{}`, 422, issues(issue("missing", `"body","text"`, "Field required"))},
		{"writer", `{"text":null,"source_url":2,"project_id":0}`, 422, issues(str("text", "null"), str("project_id", "number"), str("source_url", "number"))},
		{"writer", `{"text":[],"project_id":null}`, 422, issues(str("text", "array"), str("project_id", "null"))},
		{"writer", `{"text":"a","source_url":false}`, 422, issues(str("source_url", "boolean"))},
		{"writer", `{"text":"a","project_id":false}`, 422, issues(str("project_id", "boolean"))},
		{"writer", `[1]`, 422, issues(issue("invalid_type", `"body"`, "Invalid input: expected object, received array"))},
		{"writer", `nope`, 422, jsonInvalid},
		{"writer", `{"text":"a","project_id":"PRJ-OTRO"}`, 403, otherWrite},
		{"writer", `{"text":"a","project_id":1}`, 403, otherWrite},
		// Not a read-only POST: the consulta role is refused, as in TypeScript.
		{"wreader", `{"text":"a"}`, 403, readOnly},
		{"", `{"text":"a"}`, 401, signIn},
	} {
		code, body := send(t, srv, "POST", path, c.user, c.body, nil)
		expect(t, code, body, c.status, c.want)
	}
}

type alertState struct {
	status                       string
	reviewerNote, firstValidator *string
	reviewedAt                   *time.Time
}

func readAlert(t *testing.T, tenant, id string) alertState {
	t.Helper()
	conn, err := pgx.Connect(t.Context(), scratch.URL)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = conn.Close(t.Context()) }()
	var s alertState
	if err := conn.QueryRow(t.Context(), `SELECT status, reviewer_note, first_validator, reviewed_at
		FROM digital_alert_reviews WHERE tenant_id = $1 AND id = $2`, tenant, id).
		Scan(&s.status, &s.reviewerNote, &s.firstValidator, &s.reviewedAt); err != nil {
		t.Fatal(err)
	}
	return s
}

type auditRow struct {
	ts                     time.Time
	module, action, detail string
	payload                map[string]any
}

func auditRows(t *testing.T, id string) []auditRow {
	t.Helper()
	conn, err := pgx.Connect(t.Context(), scratch.URL)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = conn.Close(t.Context()) }()
	rows, err := conn.Query(t.Context(), `SELECT ts, module, action, detail, event_payload FROM audit
		WHERE tenant_id = $1 AND record_id = $2 ORDER BY id`, writeTenant, id)
	if err != nil {
		t.Fatal(err)
	}
	out, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (auditRow, error) {
		var a auditRow
		err := row.Scan(&a.ts, &a.module, &a.action, &a.detail, &a.payload)
		return a, err
	})
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func decided(status string, second bool) string {
	s := "false"
	if second {
		s = "true"
	}
	return `{"ok":true,"status":"` + status + `","second_validation_required":` + s +
		`,"irsa_modified":false,"notice":"La validación NO cambia el IRSA. Registrar cambios de indicadores requiere metodología aprobada."}`
}

const alertPath = "/system/intelligence/territorial-alerts/"

func TestDecisionUpdatesTheAlertAndAudits(t *testing.T) {
	seedWrites(t)
	srv := start(t)
	body := `{"status":"Descartado","reviewer_note":"Sin sustento"}`
	code, got := send(t, srv, "PATCH", alertPath+"W-MEDIA", "writer", body, nil)
	expect(t, code, got, http.StatusOK, decided("Descartado", false))
	s := readAlert(t, writeTenant, "W-MEDIA")
	if s.status != "Descartado" || s.reviewerNote == nil || *s.reviewerNote != "Sin sustento" ||
		s.reviewedAt == nil || !s.reviewedAt.Equal(t0) || s.firstValidator != nil {
		t.Fatalf("stored %+v", s)
	}
	// The route's own read shows the decision.
	code, got = get(t, srv, alertPath+"W-MEDIA", "writer", nil)
	if code != http.StatusOK || !strings.Contains(got, `"status":"Descartado","analyst_note":"","reviewer_note":"Sin sustento","reviewed_at":"2026-11-03T11:00:00Z","first_validator":null`) {
		t.Fatalf("read after write: %d %s", code, got)
	}
	// Repeating the decision answers the same and audits it again.
	code, got = send(t, srv, "PATCH", alertPath+"W-MEDIA", "writer", body, nil)
	expect(t, code, got, http.StatusOK, decided("Descartado", false))
	audits := auditRows(t, "W-MEDIA")
	if len(audits) != 2 {
		t.Fatalf("audit rows: %+v", audits)
	}
	a := audits[0]
	wantPayload := map[string]any{"id": "W-MEDIA", "project_id": "PRJ-W", "level": "Media", "status": "Descartado",
		"score": float64(7), "territory": nil, "source_url": "https://example.org/n", "source_type": "Documento",
		"source_record": nil, "sha256": sha}
	if a.module != "InteligenciaDigital" || a.action != "REVIEW" || a.detail != "Descartado" || !a.ts.Equal(t0) {
		t.Fatalf("audit %+v", a)
	}
	if g, w := mustJSON(t, a.payload), mustJSON(t, wantPayload); g != w {
		t.Fatalf("audit payload\ngot  %s\nwant %s", g, w)
	}
	// reviewer_note defaults to "".
	code, got = send(t, srv, "PATCH", alertPath+"W-MEDIA", "writer", `{"status":"Pendiente de verificación"}`, nil)
	expect(t, code, got, http.StatusOK, decided("Pendiente de verificación", false))
	if s := readAlert(t, writeTenant, "W-MEDIA"); s.reviewerNote == nil || *s.reviewerNote != "" {
		t.Fatalf("stored %+v", s)
	}
}

func mustJSON(t *testing.T, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestHighPriorityDecisionsNeedTwoPeople(t *testing.T) {
	seedWrites(t)
	srv := start(t)
	verify := `{"status":"Corroborado","reviewer_note":"Primera"}`
	// First validation: recorded, the status stays.
	code, got := send(t, srv, "PATCH", alertPath+"W-ALTA-1", "writer", verify, nil)
	expect(t, code, got, http.StatusOK, decided("Pendiente de verificación", true))
	s := readAlert(t, writeTenant, "W-ALTA-1")
	if s.status != "Pendiente de verificación" || s.firstValidator == nil || *s.firstValidator != "writer" ||
		*s.reviewerNote != "Primera" || s.reviewedAt != nil {
		t.Fatalf("stored %+v", s)
	}
	// The same person cannot confirm it.
	code, got = send(t, srv, "PATCH", alertPath+"W-ALTA-1", "writer", verify, nil)
	expect(t, code, got, http.StatusConflict, `{"detail":"Otra persona debe confirmar la validación de una alerta de prioridad Alta"}`)
	// Another person confirms; the first validator stays on an actionable status.
	code, got = send(t, srv, "PATCH", alertPath+"W-ALTA-1", "wcolega", `{"status":"Corroborado","reviewer_note":"Segunda"}`, nil)
	expect(t, code, got, http.StatusOK, decided("Corroborado", false))
	s = readAlert(t, writeTenant, "W-ALTA-1")
	if s.status != "Corroborado" || *s.firstValidator != "writer" || *s.reviewerNote != "Segunda" {
		t.Fatalf("stored %+v", s)
	}
	audits := auditRows(t, "W-ALTA-1")
	if len(audits) != 2 || audits[0].detail != "Primera validación: writer" ||
		audits[0].payload["status"] != "Pendiente de verificación" ||
		audits[1].detail != "Corroborado (primera validación: writer)" || audits[1].payload["status"] != "Corroborado" {
		t.Fatalf("audit %+v", audits)
	}
	// A non-actionable status clears the first validator.
	code, got = send(t, srv, "PATCH", alertPath+"W-ALTA-1", "wcoord", `{"status":"Descartado"}`, nil)
	expect(t, code, got, http.StatusOK, decided("Descartado", false))
	if s := readAlert(t, writeTenant, "W-ALTA-1"); s.firstValidator != nil {
		t.Fatalf("stored %+v", s)
	}
	if a := auditRows(t, "W-ALTA-1"); a[2].detail != "Descartado" {
		t.Fatalf("audit %+v", a[2])
	}

	// Seeded with another first validator: one decision applies it, and repeating it too.
	for range 2 {
		code, got = send(t, srv, "PATCH", alertPath+"W-ALTA-2", "writer", verify, nil)
		expect(t, code, got, http.StatusOK, decided("Corroborado", false))
	}
	if a := auditRows(t, "W-ALTA-2"); a[0].detail != "Corroborado (primera validación: wcolega)" ||
		mustJSON(t, a[0].payload["source_record"]) != `{"id":"NAR-9","module":"Narrativas"}` { //nolint:misspell // Spanish module name
		t.Fatalf("audit %+v", a[0])
	}
	// Seeded with this actor as the first validator: refused, nothing written.
	code, got = send(t, srv, "PATCH", alertPath+"W-ALTA-3", "writer", `{"status":"En seguimiento"}`, nil)
	expect(t, code, got, http.StatusConflict, `{"detail":"Otra persona debe confirmar la validación de una alerta de prioridad Alta"}`)
	if s := readAlert(t, writeTenant, "W-ALTA-3"); s.status != "Pendiente de verificación" || len(auditRows(t, "W-ALTA-3")) != 0 {
		t.Fatalf("stored %+v", s)
	}
}

func TestDecisionErrorsAndScope(t *testing.T) {
	seedWrites(t)
	srv := start(t)
	ok := `{"status":"Descartado"}`
	for _, c := range []struct {
		user, id, body string
		headers        map[string]string
		status         int
		want           string
	}{
		{"writer", "W-ALTA-4", `{"status":"Cerrado"}`, nil, 422, `{"detail":"Estado inválido"}`},
		{"writer", "W-ALTA-4", `{"status":"Descartado","reviewer_note":"` + strings.Repeat("ñ", 2001) + `"}`, nil, 422, `{"detail":"Nota demasiado extensa"}`},
		// Invalid UTF-8 decodes as TextDecoder does: one U+FFFD per invalid byte here, 2001 code points.
		{"writer", "W-ALTA-4", `{"status":"Descartado","reviewer_note":"` + strings.Repeat("ñ", 1999) + "\xff\xff" + `"}`, nil, 422, `{"detail":"Nota demasiado extensa"}`},
		{"writer", strings.Repeat("A", 65), ok, nil, 404, `{"detail":"Evaluación no encontrada"}`},
		{"writer", "W-NADA", ok, nil, 404, `{"detail":"Evaluación no encontrada"}`},
		// Another project of the tenant, and another tenant's alert (DIG-A of SIPGES/PRJ-SECHURA).
		{"writer", "W-OTRO", ok, nil, 404, `{"detail":"Evaluación no encontrada"}`},
		{"writer", "DIG-A", ok, nil, 404, `{"detail":"Evaluación no encontrada"}`},
		{"writer", "W-ALTA-4", `{}`, nil, 422, issues(issue("missing", `"body","status"`, "Field required"))},
		{"writer", "W-ALTA-4", `{"status":1,"reviewer_note":3}`, nil, 422, issues(
			issue("invalid_type", `"body","status"`, "Invalid input: expected string, received number"),
			issue("invalid_type", `"body","reviewer_note"`, "Invalid input: expected string, received number"))},
		{"writer", "W-ALTA-4", `{"status":"x","reviewer_note":null}`, nil, 422, issues(
			issue("invalid_type", `"body","reviewer_note"`, "Invalid input: expected string, received null"))},
		{"writer", "W-ALTA-4", `x`, nil, 422, jsonInvalid},
		{"writer", "W-ALTA-4", `{"status":"Descartado","project_id":"PRJ-OTRO"}`, nil, 403, otherWrite},
		{"writer", "W-ALTA-4", ok, map[string]string{"Origin": "https://evil.example"}, 403, badOrigin},
		{"wreader", "W-ALTA-4", ok, nil, 403, readOnly},
		{"", "W-ALTA-4", ok, nil, 401, signIn},
		{"writer", "W-ALTA-4", ok, map[string]string{"X-SIPGES-Scope": "SIPGES/PRJ-SECHURA"}, 403,
			`{"detail":"Seleccione un proyecto autorizado mediante X-SIPGES-Scope o /select-project","projects":["WRITE/PRJ-W"]}`},
	} {
		code, got := send(t, srv, "PATCH", alertPath+c.id, c.user, c.body, c.headers)
		expect(t, code, got, c.status, c.want)
	}
	for _, id := range []string{"W-ALTA-4", "W-OTRO"} {
		if s := readAlert(t, writeTenant, id); s.status != "Pendiente de verificación" || s.reviewerNote != nil || len(auditRows(t, id)) != 0 {
			t.Fatalf("%s changed: %+v", id, s)
		}
	}
	if s := readAlert(t, "SIPGES/PRJ-SECHURA", "DIG-A"); s.status != "Corroborado" || *s.reviewerNote != "Revisado" {
		t.Fatalf("another tenant's alert changed: %+v", s)
	}
	// A coordinator may decide alerts; the encoded id is decoded as Hono does.
	code, got := send(t, srv, "PATCH", alertPath+"W%2DALTA-4", "wcoord", ok, nil)
	expect(t, code, got, http.StatusOK, decided("Descartado", false))
	code, got = send(t, srv, "PATCH", alertPath, "writer", ok, nil)
	expect(t, code, got, http.StatusNotFound, notFound)
}
