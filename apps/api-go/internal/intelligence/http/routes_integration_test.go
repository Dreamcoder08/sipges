package http_test

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/app"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/identity/infrastructure"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/database/dbtest"
)

// The intelligence read routes against a migrated synthetic PostgreSQL, through the composed
// handler (session, project scope, role gate). Every account, project and alert is synthetic.

var scratch *dbtest.Scratch

func TestMain(m *testing.M) { os.Exit(run(m)) }

func run(m *testing.M) int {
	adminURL := os.Getenv(dbtest.EnvAdminURL)
	if adminURL == "" {
		return m.Run() // integration tests skip themselves
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	s, err := dbtest.NewScratch(ctx, adminURL)
	if err != nil {
		fmt.Fprintln(os.Stderr, "scratch database:", err)
		return 1
	}
	defer func() {
		if err := s.Drop(context.Background()); err != nil {
			fmt.Fprintln(os.Stderr, "drop scratch database:", err)
		}
	}()
	if err := seed(ctx, s.URL); err != nil {
		fmt.Fprintln(os.Stderr, "seed scratch database:", err)
		return 1
	}
	scratch = s
	return m.Run()
}

var t0 = time.Date(2026, 11, 3, 11, 0, 0, 0, time.UTC)

var tokens = map[string]string{}

const sha = "ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12"

// tenantRows inserts one tenant's rows inside a transaction entered as that tenant, so the
// row-level security policies hold even for a non-superuser test login.
func tenantRows(ctx context.Context, conn *pgx.Conn, tenant, sql string) error {
	tx, err := conn.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenant); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, sql); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// alertRow is one digital_alert_reviews row; extra holds the optional columns' values.
func alertRow(tenant, project, id, createdAt, level, status, themes string, extra string) string {
	if extra == "" {
		extra = "NULL, NULL, NULL, NULL, NULL"
	}
	return fmt.Sprintf(`('%s', '%s', '%s', '%s', 'https://example.org/n', 'Documento', 'Texto %s',
		'%s', '%s', 7, 'Reglas', '%s', '[{"tipo":"actor","valor":"Comunidad"}]', '["Verificar"]', false,
		'%s', '', %s)`, tenant, id, project, createdAt, id, sha, level, themes, status, extra)
}

const columns = `INSERT INTO digital_alert_reviews (tenant_id, id, project_id, created_at, source_url,
  source_type, excerpt, sha256, level, score, method, themes, signals, suggestions, semantic_active,
  status, analyst_note, reviewer_note, reviewed_at, territory, source_record, first_validator) VALUES `

func seed(ctx context.Context, dsn string) error {
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		return err
	}
	defer func() { _ = conn.Close(ctx) }()
	if _, err := conn.Exec(ctx, `
		INSERT INTO tenants (company_id, project_id, label) VALUES
		  ('SIPGES','PRJ-SECHURA','Sechura'), ('ACME','NORTE','Norte') ON CONFLICT DO NOTHING;
		INSERT INTO users (username, full_name, password_hash, role, active, totp_enabled) VALUES
		  ('multi',  'Multi Admin',  'x', 'admin',    true, true),
		  ('solo',   'Solo Analyst', 'x', 'analista', true, true),
		  ('reader', 'Read Only',    'x', 'consulta', true, true);
		INSERT INTO grants (username, tenant_id) VALUES
		  ('multi','SIPGES/PRJ-SECHURA'), ('multi','ACME/NORTE'),
		  ('solo','SIPGES/PRJ-SECHURA'), ('reader','SIPGES/PRJ-SECHURA');`); err != nil {
		return err
	}
	const s = "SIPGES/PRJ-SECHURA"
	sechura := columns +
		alertRow(s, "PRJ-SECHURA", "DIG-A", "2026-10-01T08:00:00.987Z", "Alta", "Corroborado",
			`[{"tema":"Agua"},{"tema":"Tierra"}]`,
			`'Revisado', '2026-10-02T09:30:00.5Z', 'Sechura', '{"module":"Fuente","id":"NAR-1"}', 'solo'`) + "," +
		alertRow(s, "PRJ-SECHURA", "DIG-B", "2026-10-03T00:00:00Z", "Media", "Pendiente de verificación",
			`[{"tema":"Tierra"}]`, "") + "," +
		// Same created_at as DIG-B: id DESC decides.
		alertRow(s, "PRJ-SECHURA", "DIG-C", "2026-10-03T00:00:00Z", "Baja", "Descartado", `[]`, "") + "," +
		// Same tenant, another project id: the project filter hides it from lists and lookups.
		alertRow(s, "OTHER", "DIG-X", "2026-10-04T00:00:00Z", "Alta", "Corroborado", `[{"tema":"Oculto"}]`, "") + ";"
	if err := tenantRows(ctx, conn, s, sechura); err != nil {
		return fmt.Errorf("sechura: %w", err)
	}
	// Another tenant reuses an id and even the project id: only RLS keeps it out of Sechura.
	norte := columns +
		alertRow("ACME/NORTE", "PRJ-SECHURA", "DIG-A", "2026-10-05T00:00:00Z", "Alta", "Corroborado", `[{"tema":"Secreto"}]`, "") + "," +
		alertRow("ACME/NORTE", "PRJ-SECHURA", "DIG-S", "2026-10-05T00:00:00Z", "Alta", "Corroborado", `[{"tema":"Secreto"}]`, "") + "," +
		alertRow("ACME/NORTE", "NORTE", "DIG-N", "2026-10-06T00:00:00Z", "Media", "En seguimiento", `[{"tema":"Pesca"}]`, "") + ";"
	if err := tenantRows(ctx, conn, "ACME/NORTE", norte); err != nil {
		return fmt.Errorf("norte: %w", err)
	}
	batch := &pgx.Batch{}
	for _, user := range []string{"multi", "solo", "reader"} {
		var b [32]byte
		_, _ = rand.Read(b[:])
		tokens[user] = hex.EncodeToString(b[:])
		batch.Queue(`INSERT INTO sessions (token_hash, username, expires_at) VALUES ($1, $2, $3)`,
			infrastructure.HashToken(tokens[user]), user, t0.Add(8*time.Hour))
	}
	return conn.SendBatch(ctx, batch).Close()
}

func start(t *testing.T) string {
	t.Helper()
	if scratch == nil {
		t.Skip(dbtest.EnvAdminURL + " is not set")
	}
	pool, err := pgxpool.New(t.Context(), scratch.URL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	h, err := app.NewHandler(pool, app.Options{
		Logger: slog.New(slog.DiscardHandler),
		Now:    func() time.Time { return t0 },
	})
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	return srv.URL
}

func get(t *testing.T, base, path, user string, headers map[string]string) (int, string) {
	t.Helper()
	r, err := http.NewRequestWithContext(t.Context(), http.MethodGet, base+path, nil)
	if err != nil {
		t.Fatal(err)
	}
	if user != "" {
		r.Header.Set("Cookie", "sipges_session="+tokens[user])
	}
	for k, v := range headers {
		r.Header.Set(k, v)
	}
	res, err := http.DefaultClient.Do(r)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = res.Body.Close() }()
	b, _ := io.ReadAll(res.Body)
	if ct := res.Header.Get("Content-Type"); !strings.HasPrefix(ct, "application/json") {
		t.Fatalf("%s: content-type %q", path, ct)
	}
	return res.StatusCode, strings.TrimSpace(string(b))
}

func expect(t *testing.T, gotStatus int, gotBody string, status int, body string) {
	t.Helper()
	if gotStatus != status || gotBody != body {
		t.Fatalf("got  %d %s\nwant %d %s", gotStatus, gotBody, status, body)
	}
}

func alertJSON(id, project, createdAt, level, status, themes, optional string) string {
	if optional == "" {
		optional = `"territory":null,"source_record":null`
	}
	reviewed := `"reviewer_note":null,"reviewed_at":null,"first_validator":null`
	if id == "DIG-A" && project == "PRJ-SECHURA" && optional != `"territory":null,"source_record":null` {
		reviewed = `"reviewer_note":"Revisado","reviewed_at":"2026-10-02T09:30:00Z","first_validator":"solo"`
	}
	return `{"id":"` + id + `","project_id":"` + project + `","created_at":"` + createdAt + `",` +
		`"source_url":"https://example.org/n","source_type":"Documento",` + optional + `,` +
		`"excerpt":"Texto ` + id + `","sha256":"` + sha + `","level":"` + level + `","score":7,"method":"Reglas",` +
		`"semantic_active":false,"status":"` + status + `","analyst_note":"",` + reviewed + `,` +
		`"themes":` + themes + `,"signals":[{"tipo":"actor","valor":"Comunidad"}],"suggestions":["Verificar"]}`
}

var (
	alertA = alertJSON("DIG-A", "PRJ-SECHURA", "2026-10-01T08:00:00Z", "Alta", "Corroborado",
		`[{"tema":"Agua"},{"tema":"Tierra"}]`, `"territory":"Sechura","source_record":{"id":"NAR-1","module":"Fuente"}`)
	alertB = alertJSON("DIG-B", "PRJ-SECHURA", "2026-10-03T00:00:00Z", "Media", "Pendiente de verificación", `[{"tema":"Tierra"}]`, "")
	alertC = alertJSON("DIG-C", "PRJ-SECHURA", "2026-10-03T00:00:00Z", "Baja", "Descartado", `[]`, "")
	alertN = alertJSON("DIG-N", "NORTE", "2026-10-06T00:00:00Z", "Media", "En seguimiento", `[{"tema":"Pesca"}]`, "")

	listSechura = "[" + alertC + "," + alertB + "," + alertA + "]"
	listNorte   = "[" + alertN + "]"

	tail           = `"irsa_integration":"Sin modificación automática del IRSA; requiere validación metodológica","caution":"Registros manuales, sin monitoreo permanente ni corroboración automática."}` //nolint:misspell // Spanish, verbatim from alerts.ts
	summarySechura = `{"version":"2.6","project_id":"PRJ-SECHURA","total":3,` +
		`"by_status":{"Pendiente de verificación":1,"Corroborado":1,"Descartado":1,"En seguimiento":0},` +
		`"by_priority":{"Alta":1,"Media":1,"Baja":1},"themes":[{"name":"Tierra","count":2},{"name":"Agua","count":1}],` + tail
	summaryNorte = `{"version":"2.6","project_id":"NORTE","total":1,` +
		`"by_status":{"Pendiente de verificación":0,"Corroborado":0,"Descartado":0,"En seguimiento":1},` +
		`"by_priority":{"Alta":0,"Media":1,"Baja":0},"themes":[{"name":"Pesca","count":1}],` + tail

	signIn     = `{"detail":"Inicie sesión para acceder a SIPGES"}`
	outOfScope = `{"detail":"Proyecto fuera de alcance"}`
	choose     = `{"detail":"Seleccione un proyecto autorizado mediante X-SIPGES-Scope o /select-project","projects":["ACME/NORTE","SIPGES/PRJ-SECHURA"]}`
	chooseSolo = `{"detail":"Seleccione un proyecto autorizado mediante X-SIPGES-Scope o /select-project","projects":["SIPGES/PRJ-SECHURA"]}`
	missing    = `{"detail":"Evaluación no encontrada"}`
	notFound   = `{"detail":"Not Found"}`
	intParsing = `{"detail":[{"type":"int_parsing","loc":["query","limit"],"msg":"Input should be a valid integer, unable to parse string as an integer"}]}`
)

const base = "/system/intelligence/"

func TestServesTheAlertsOfTheResolvedProject(t *testing.T) {
	srv := start(t)
	for _, c := range []struct{ path, sechura, norte string }{
		{base + "territorial-alerts", listSechura, listNorte},
		{base + "territorial-summary", summarySechura, summaryNorte},
		{base + "territorial-alerts/DIG-A", alertA, missing},
		{base + "territorial-alerts/DIG-N", missing, alertN},
	} {
		t.Run(c.path, func(t *testing.T) {
			status := func(body string) int {
				if body == missing {
					return http.StatusNotFound
				}
				return http.StatusOK
			}
			code, body := get(t, srv, c.path, "solo", nil)
			expect(t, code, body, status(c.sechura), c.sechura)
			// The read-only role reads the same alerts.
			code, body = get(t, srv, c.path, "reader", nil)
			expect(t, code, body, status(c.sechura), c.sechura)
			code, body = get(t, srv, c.path+"?project_id=PRJ-SECHURA", "solo", nil)
			expect(t, code, body, status(c.sechura), c.sechura)
			// A two-project user sees each project's alerts only, never the other tenant's.
			code, body = get(t, srv, c.path, "multi", map[string]string{"X-SIPGES-Scope": "SIPGES/PRJ-SECHURA"})
			expect(t, code, body, status(c.sechura), c.sechura)
			code, body = get(t, srv, c.path, "multi", map[string]string{"X-SIPGES-Scope": "ACME/NORTE"})
			expect(t, code, body, status(c.norte), c.norte)
		})
	}
}

func TestListLimitAndLookups(t *testing.T) {
	srv := start(t)
	for _, c := range []struct {
		path   string
		status int
		body   string
	}{
		{"territorial-alerts?limit=1", 200, "[" + alertC + "]"},
		{"territorial-alerts?limit=%202%20", 200, "[" + alertC + "," + alertB + "]"},
		{"territorial-alerts?limit=0", 200, "[" + alertC + "]"},
		{"territorial-alerts?limit=-9", 200, "[" + alertC + "]"},
		{"territorial-alerts?limit=99999999999999999999", 200, listSechura},
		{"territorial-alerts?limit=", 422, intParsing},
		{"territorial-alerts?limit=1.5", 422, intParsing},
		{"territorial-alerts?limit=dos", 422, intParsing},
		// Another project of the same tenant, another tenant's row, an id that is too long.
		{"territorial-alerts/DIG-X", 404, missing},
		{"territorial-alerts/DIG-S", 404, missing},
		{"territorial-alerts/" + strings.Repeat("A", 81), 404, missing},
		{"territorial-alerts/DIG%2DA", 200, alertA},
		{"territorial-alerts/", 404, notFound},
		{"territorial-alerts/DIG-A/", 404, notFound},
		{"territorial-summary/", 404, notFound},
	} {
		code, body := get(t, srv, base+c.path, "solo", nil)
		expect(t, code, body, c.status, c.body)
	}
}

func TestRefusesRequestsOutsideTheScope(t *testing.T) {
	srv := start(t)
	for _, path := range []string{base + "territorial-alerts", base + "territorial-summary", base + "territorial-alerts/DIG-A"} {
		t.Run(path, func(t *testing.T) {
			code, body := get(t, srv, path, "", nil)
			expect(t, code, body, http.StatusUnauthorized, signIn)
			code, body = get(t, srv, path, "solo", map[string]string{"X-SIPGES-Scope": "ACME/NORTE"})
			expect(t, code, body, http.StatusForbidden, chooseSolo)
			code, body = get(t, srv, path+"?project_id=NORTE", "solo", nil)
			expect(t, code, body, http.StatusForbidden, outOfScope)
			code, body = get(t, srv, path, "multi", nil)
			expect(t, code, body, http.StatusForbidden, choose)
		})
	}
}

// embedderServer is a synthetic embeddings server; no real provider is ever contacted here.
func embedderServer(t *testing.T, status int, calls *atomic.Int32) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		w.WriteHeader(status)
		_, _ = io.WriteString(w, `{"embeddings":[[1,0,0,0,0,0,0,0.1]]}`)
	}))
	t.Cleanup(srv.Close)
	return srv
}

func TestEmbedderReportsAReachableServer(t *testing.T) {
	var calls atomic.Int32
	t.Setenv("SIPGES_OLLAMA_URL", embedderServer(t, http.StatusOK, &calls).URL)
	t.Setenv("SIPGES_OLLAMA_EMBED_MODEL", "fake-embed")
	t.Setenv("SIPGES_SEMANTIC_SEARCH", "1")
	base := start(t)
	const want = `{"configured":true,"available":true,"reason":null,"model":"fake-embed","egress":"local","semantic_search":true}`
	for range 2 {
		status, body := get(t, base, "/system/intelligence/embedder", "solo", nil)
		if status != http.StatusOK || strings.TrimSpace(body) != want {
			t.Fatalf("%d %s", status, body)
		}
	}
	if calls.Load() != 1 {
		t.Fatalf("probes = %d", calls.Load())
	}
}

func TestEmbedderReportsAnUnreachableServer(t *testing.T) {
	var calls atomic.Int32
	t.Setenv("SIPGES_OLLAMA_URL", embedderServer(t, http.StatusServiceUnavailable, &calls).URL)
	base := start(t)
	status, body := get(t, base, "/system/intelligence/embedder", "reader", nil)
	const want = `{"configured":true,"available":false,"reason":"unreachable","model":"nomic-embed-text","egress":"local","semantic_search":false}`
	if status != http.StatusOK || strings.TrimSpace(body) != want {
		t.Fatalf("%d %s", status, body)
	}
}

func TestEmbedderKeepsAnExternalServerUncontactedWhileTheSwitchIsOff(t *testing.T) {
	// A routable address nothing listens on: the point is that no connection is attempted.
	t.Setenv("SIPGES_OLLAMA_URL", "http://192.0.2.1:11434")
	base := start(t)
	status, body := get(t, base, "/system/intelligence/embedder", "solo", nil)
	const want = `{"configured":true,"available":false,"reason":"external_ai_disabled","model":"nomic-embed-text","egress":"external","semantic_search":false}`
	if status != http.StatusOK || strings.TrimSpace(body) != want {
		t.Fatalf("%d %s", status, body)
	}
}

func TestEmbedderNeedsASession(t *testing.T) {
	var calls atomic.Int32
	t.Setenv("SIPGES_OLLAMA_URL", embedderServer(t, http.StatusOK, &calls).URL)
	base := start(t)
	if status, _ := get(t, base, "/system/intelligence/embedder", "", nil); status != http.StatusUnauthorized {
		t.Fatalf("status = %d", status)
	}
	if calls.Load() != 0 {
		t.Fatal("probed for an anonymous request")
	}
}

func TestAMalformedEmbedderURLStopsTheStart(t *testing.T) {
	if scratch == nil {
		t.Skip(dbtest.EnvAdminURL + " is not set")
	}
	t.Setenv("SIPGES_OLLAMA_URL", "ftp://127.0.0.1")
	pool, err := pgxpool.New(t.Context(), scratch.URL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	_, err = app.NewHandler(pool, app.Options{Logger: slog.New(slog.DiscardHandler)})
	if err == nil || !strings.Contains(err.Error(), "SIPGES_OLLAMA_URL must use http or https") {
		t.Fatalf("error = %v", err)
	}
}

func TestSemanticAnalysisUsesTheEmbedderThroughTheComposedHandler(t *testing.T) {
	var calls atomic.Int32
	t.Setenv("SIPGES_OLLAMA_URL", embedderServer(t, http.StatusOK, &calls).URL)
	srv := start(t)
	code, body := send(t, srv, http.MethodPost, "/system/intelligence/semantic-analyze", "reader",
		`{"text":"Texto sintético sobre agua","mode":"semantic"}`, nil)
	if code != http.StatusOK || !strings.Contains(body, `"version":"2.5"`) || !strings.Contains(body, `"active":true`) {
		t.Fatalf("%d %s", code, body)
	}
	if calls.Load() != 8 {
		t.Fatalf("embeddings = %d", calls.Load())
	}
}

func TestSemanticAnalysisDefaultsToAutomatic(t *testing.T) {
	var calls atomic.Int32
	t.Setenv("SIPGES_OLLAMA_URL", embedderServer(t, http.StatusBadGateway, &calls).URL)
	srv := start(t)
	code, body := send(t, srv, http.MethodPost, "/system/intelligence/semantic-analyze", "solo", `{"text":"Texto"}`, nil)
	if code != http.StatusOK || !strings.Contains(body, "Ollama local no disponible") {
		t.Fatalf("%d %s", code, body)
	}
}

func TestSemanticAnalysisAnswersTheRefusalsOfTypeScript(t *testing.T) {
	var calls atomic.Int32
	t.Setenv("SIPGES_OLLAMA_URL", embedderServer(t, http.StatusBadGateway, &calls).URL)
	srv := start(t)
	long := strings.Repeat("x", 20_001)
	cases := []struct {
		name, body string
		status     int
		detail     string
	}{
		{"empty", `{"text":"  "}`, 422, "Ingrese el texto transcrito de la publicación."}, //nolint:misspell // Spanish, verbatim
		{"too long", `{"text":"` + long + `"}`, 413, "Máximo 20 000 caracteres."},
		{"mode", `{"text":"t","mode":"x"}`, 422, "Modo inválido"},
		{"url", `{"text":"t","source_url":"ftp://x"}`, 422, "URL pública inválida"},
		{"unavailable", `{"text":"t","mode":"semantic"}`, 503, "Modelo local no disponible. Instale Ollama, descargue el modelo configurado o seleccione análisis por reglas."},
	}
	for _, c := range cases {
		code, body := send(t, srv, http.MethodPost, "/system/intelligence/semantic-analyze", "solo", c.body, nil)
		want := `{"detail":"` + c.detail + `"}`
		if code != c.status || strings.TrimSpace(body) != want {
			t.Errorf("%s: %d %s", c.name, code, body)
		}
	}
}

func TestSemanticAnalysisKeepsTextFromAnExternalServerWhileTheSwitchIsOff(t *testing.T) {
	// A routable address nothing listens on: the point is that no connection is attempted, which
	// a timeout of the 12 s embedding call would show as a slow test.
	t.Setenv("SIPGES_OLLAMA_URL", "http://192.0.2.1:11434")
	srv := start(t)
	began := time.Now()
	code, body := send(t, srv, http.MethodPost, "/system/intelligence/semantic-analyze", "solo", `{"text":"t","mode":"semantic"}`, nil)
	if code != http.StatusServiceUnavailable {
		t.Fatalf("%d %s", code, body)
	}
	if time.Since(began) > 5*time.Second {
		t.Fatal("a connection was attempted")
	}
}

func TestSemanticAnalysisWritesNothing(t *testing.T) {
	var calls atomic.Int32
	t.Setenv("SIPGES_OLLAMA_URL", embedderServer(t, http.StatusOK, &calls).URL)
	srv := start(t)
	_, before := get(t, srv, "/system/intelligence/territorial-alerts", "solo", nil)
	code, _ := send(t, srv, http.MethodPost, "/system/intelligence/semantic-analyze", "solo", `{"text":"Texto"}`, nil)
	_, after := get(t, srv, "/system/intelligence/territorial-alerts", "solo", nil)
	if code != http.StatusOK || before != after {
		t.Fatalf("%d, the inbox changed", code)
	}
}
