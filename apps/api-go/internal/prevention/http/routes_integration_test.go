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
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/app"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/identity/infrastructure"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/database/dbtest"
)

// The prevention read routes against a migrated synthetic PostgreSQL, through the composed
// handler (session, project scope, role gate). Every account, project and plan is synthetic.

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

// t0 is the synthetic "now": today is 2026-11-03 for the overdue rule.
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

func alert(tenant, project, id string) string {
	return fmt.Sprintf(`INSERT INTO digital_alert_reviews (tenant_id, id, project_id, created_at, source_url,
		source_type, excerpt, sha256, level, score, method, themes, signals, suggestions, semantic_active,
		status, analyst_note) VALUES ('%s', '%s', '%s', '2026-09-01T00:00:00Z', '', 'Documento', 'Texto',
		'%s', 'Baja', 1, 'rules', '[]', '[]', '[]', false, 'En seguimiento', '');`, tenant, id, project, sha)
}

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
	sechura := alert("SIPGES/PRJ-SECHURA", "PRJ-SECHURA", "ALERT-S") + `
		INSERT INTO preventive_actions (tenant_id, id, project_id, alert_id, title, responsible, due_date,
		  description, status, progress, created_at, updated_at, blocked_by, blocked_reason, blocked_since) VALUES
		  ('SIPGES/PRJ-SECHURA','PREV-A','PRJ-SECHURA','ALERT-S','Plan vencido','Equipo','2026-01-10','Sin avance',
		   'Pendiente',0,'2026-10-01T08:00:00.123Z','2026-10-01T08:00:00.123Z',NULL,NULL,NULL),
		  ('SIPGES/PRJ-SECHURA','PREV-B','PRJ-SECHURA','ALERT-S','Plan bloqueado','Equipo','2099-01-01','',
		   'En ejecución',40,'2026-10-02T09:00:00Z','2026-10-05T10:00:00.999Z','Comunidad','Asamblea','2026-10-05T10:00:00Z'),
		  ('SIPGES/PRJ-SECHURA','PREV-C','PRJ-SECHURA','ALERT-S','Plan cerrado','Equipo','2025-05-05','',
		   'Completada',100,'2025-01-01T00:00:00Z','2025-05-01T00:00:00Z',NULL,NULL,NULL),
		  -- Same tenant, another project id: the project filter hides it.
		  ('SIPGES/PRJ-SECHURA','PREV-X','OTHER','ALERT-S','Otro proyecto','Equipo','2020-01-01','',
		   'Pendiente',0,'2026-10-01T00:00:00Z','2026-10-01T00:00:00Z',NULL,NULL,NULL);
		INSERT INTO preventive_action_log (tenant_id, id, action_id, created_at, status, progress, note,
		  evidence_url, decided_by, evidence_attachment_id, evidence_file_name, evidence_sha256) VALUES
		  ('SIPGES/PRJ-SECHURA','LOG-1','PREV-A','2026-10-01T08:00:00.123Z','Pendiente',0,'Plan creado',NULL,NULL,NULL,NULL,NULL),
		  ('SIPGES/PRJ-SECHURA','LOG-2','PREV-B','2026-10-02T09:00:00Z','Pendiente',0,'Plan creado',NULL,NULL,NULL,NULL,NULL),
		  ('SIPGES/PRJ-SECHURA','LOG-3','PREV-B','2026-10-05T10:00:00Z','En ejecución',40,'Avance',
		   'https://example.org/a','solo','ATT-1','acta.pdf','` + sha + `'),
		  -- A receipt without its hash is no receipt.
		  ('SIPGES/PRJ-SECHURA','LOG-4','PREV-C','2025-05-01T00:00:00Z','Completada',100,'Cerrado','',NULL,'ATT-2','x.pdf',NULL);`
	if err := tenantRows(ctx, conn, "SIPGES/PRJ-SECHURA", sechura); err != nil {
		return fmt.Errorf("sechura: %w", err)
	}
	// Another tenant reuses the ids and even the project id: only RLS keeps it out of Sechura.
	norte := alert("ACME/NORTE", "NORTE", "ALERT-S") + `
		INSERT INTO preventive_actions (tenant_id, id, project_id, alert_id, title, responsible, due_date,
		  description, status, progress, created_at, updated_at) VALUES
		  ('ACME/NORTE','PREV-A','PRJ-SECHURA','ALERT-S','Norte secreto','Norte','2020-01-01','',
		   'Pendiente',0,'2026-10-01T00:00:00Z','2026-10-01T00:00:00Z'),
		  ('ACME/NORTE','PREV-N','NORTE','ALERT-S','Plan del norte','Norte','2099-02-02','',
		   'En ejecución',10,'2026-10-01T00:00:00Z','2026-10-01T00:00:00Z');
		INSERT INTO preventive_action_log (tenant_id, id, action_id, created_at, status, progress, note) VALUES
		  ('ACME/NORTE','LOG-1','PREV-A','2026-10-01T00:00:00Z','Pendiente',0,'Norte secreto'),
		  ('ACME/NORTE','LOG-9','PREV-N','2026-10-01T00:00:00Z','Pendiente',0,'Plan creado');`
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

const (
	listSechura = `[` +
		`{"id":"PREV-C","project_id":"PRJ-SECHURA","alert_id":"ALERT-S","title":"Plan cerrado","responsible":"Equipo","due_date":"2025-05-05","description":"","status":"Completada","progress":100,"created_at":"2025-01-01T00:00:00Z","updated_at":"2025-05-01T00:00:00Z","blocked":null,` +
		`"history":[{"id":"LOG-4","action_id":"PREV-C","created_at":"2025-05-01T00:00:00Z","status":"Completada","progress":100,"note":"Cerrado","evidence_url":"","receipt":null}]},` +
		`{"id":"PREV-A","project_id":"PRJ-SECHURA","alert_id":"ALERT-S","title":"Plan vencido","responsible":"Equipo","due_date":"2026-01-10","description":"Sin avance","status":"Pendiente","progress":0,"created_at":"2026-10-01T08:00:00Z","updated_at":"2026-10-01T08:00:00Z","blocked":null,` +
		`"history":[{"id":"LOG-1","action_id":"PREV-A","created_at":"2026-10-01T08:00:00Z","status":"Pendiente","progress":0,"note":"Plan creado","evidence_url":null,"receipt":null}]},` +
		`{"id":"PREV-B","project_id":"PRJ-SECHURA","alert_id":"ALERT-S","title":"Plan bloqueado","responsible":"Equipo","due_date":"2099-01-01","description":"","status":"En ejecución","progress":40,"created_at":"2026-10-02T09:00:00Z","updated_at":"2026-10-05T10:00:00Z","blocked":{"by":"Comunidad","reason":"Asamblea","since":"2026-10-05T10:00:00Z"},` +
		`"history":[{"id":"LOG-3","action_id":"PREV-B","created_at":"2026-10-05T10:00:00Z","status":"En ejecución","progress":40,"note":"Avance","evidence_url":"https://example.org/a","receipt":{"attachment_id":"ATT-1","file_name":"acta.pdf","sha256":"` + sha + `","decided_by":"solo"}},` +
		`{"id":"LOG-2","action_id":"PREV-B","created_at":"2026-10-02T09:00:00Z","status":"Pendiente","progress":0,"note":"Plan creado","evidence_url":null,"receipt":null}]}]`
	listNorte = `[{"id":"PREV-N","project_id":"NORTE","alert_id":"ALERT-S","title":"Plan del norte","responsible":"Norte","due_date":"2099-02-02","description":"","status":"En ejecución","progress":10,"created_at":"2026-10-01T00:00:00Z","updated_at":"2026-10-01T00:00:00Z","blocked":null,` +
		`"history":[{"id":"LOG-9","action_id":"PREV-N","created_at":"2026-10-01T00:00:00Z","status":"Pendiente","progress":0,"note":"Plan creado","evidence_url":null,"receipt":null}]}]`
	summarySechura = `{"project_id":"PRJ-SECHURA","total":3,"active":2,"overdue":1,"completed":1,"completion_percent":33.3,"average_progress":46.7,"irsa_modified":false,"notice":"Métricas operativas de acciones; no equivalen a una disminución validada del riesgo social."}`
	summaryNorte   = `{"project_id":"NORTE","total":1,"active":1,"overdue":0,"completed":0,"completion_percent":0,"average_progress":10,"irsa_modified":false,"notice":"Métricas operativas de acciones; no equivalen a una disminución validada del riesgo social."}`
	roomSechura    = `{"blocked":[{"id":"PREV-B","title":"Plan bloqueado","responsible":"Equipo","due_date":"2099-01-01","status":"En ejecución","progress":40,"blocked_by":"Comunidad","blocked_reason":"Asamblea","blocked_since":"2026-10-05T10:00:00Z"}],` +
		`"overdue":[{"id":"PREV-A","title":"Plan vencido","responsible":"Equipo","due_date":"2026-01-10","status":"Pendiente","progress":0,"blocked_by":null,"blocked_reason":null,"blocked_since":null}],` +
		`"moving":0,"blocked_by_count":{"Comunidad":1}}`
	roomNorte = `{"blocked":[],"overdue":[],"moving":1,"blocked_by_count":{}}`

	signIn     = `{"detail":"Inicie sesión para acceder a SIPGES"}`
	outOfScope = `{"detail":"Proyecto fuera de alcance"}`
	choose     = `{"detail":"Seleccione un proyecto autorizado mediante X-SIPGES-Scope o /select-project","projects":["ACME/NORTE","SIPGES/PRJ-SECHURA"]}`
	chooseSolo = `{"detail":"Seleccione un proyecto autorizado mediante X-SIPGES-Scope o /select-project","projects":["SIPGES/PRJ-SECHURA"]}`
	notFound   = `{"detail":"Not Found"}`
)

func TestServesThePlansOfTheResolvedProject(t *testing.T) {
	base := start(t)
	for _, c := range []struct{ path, sechura, norte string }{
		{"/system/prevention/actions", listSechura, listNorte},
		{"/system/prevention/summary", summarySechura, summaryNorte},
		{"/system/prevention/situation-room", roomSechura, roomNorte},
	} {
		t.Run(c.path, func(t *testing.T) {
			status, body := get(t, base, c.path, "solo", nil)
			expect(t, status, body, http.StatusOK, c.sechura)
			// The read-only role reads the same plans.
			status, body = get(t, base, c.path, "reader", nil)
			expect(t, status, body, http.StatusOK, c.sechura)
			status, body = get(t, base, c.path+"?project_id=PRJ-SECHURA", "solo", nil)
			expect(t, status, body, http.StatusOK, c.sechura)
			// A two-project user sees each project's plans only, never the other tenant's.
			status, body = get(t, base, c.path, "multi", map[string]string{"X-SIPGES-Scope": "SIPGES/PRJ-SECHURA"})
			expect(t, status, body, http.StatusOK, c.sechura)
			status, body = get(t, base, c.path, "multi", map[string]string{"X-SIPGES-Scope": "ACME/NORTE"})
			expect(t, status, body, http.StatusOK, c.norte)
		})
	}
}

func TestRefusesRequestsOutsideTheScope(t *testing.T) {
	base := start(t)
	for _, path := range []string{"/system/prevention/actions", "/system/prevention/summary", "/system/prevention/situation-room"} {
		t.Run(path, func(t *testing.T) {
			status, body := get(t, base, path, "", nil)
			expect(t, status, body, http.StatusUnauthorized, signIn)
			status, body = get(t, base, path, "solo", map[string]string{"X-SIPGES-Scope": "ACME/NORTE"})
			expect(t, status, body, http.StatusForbidden, chooseSolo)
			status, body = get(t, base, path+"?project_id=NORTE", "solo", nil)
			expect(t, status, body, http.StatusForbidden, outOfScope)
			status, body = get(t, base, path, "multi", nil)
			expect(t, status, body, http.StatusForbidden, choose)
		})
	}
	status, body := get(t, base, "/system/prevention/actions/", "solo", nil)
	expect(t, status, body, http.StatusNotFound, notFound)
}
