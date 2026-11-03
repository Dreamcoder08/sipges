//nolint:misspell // Spanish record fields and labels, verbatim from the TypeScript API.
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

// The ontology read routes against a migrated synthetic PostgreSQL, through the composed
// handler (session, project scope, role gate). Two tenants hold records and links with the
// same ids; only row-level security keeps each one's rows apart. Every value is synthetic.

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

// rows are one tenant's records and links; tag marks every text so a leak shows.
func rows(tenant, tag string) string {
	return fmt.Sprintf(`
		INSERT INTO module_records (tenant_id, module, id, payload, marking, created_at, updated_at) VALUES
		  ('%[1]s', 'Actores', 'A1', '{"Nombre_Actor/Organizacion": "Asociación clave %[2]s"}', 'interno', now(), '2026-01-01Z'),
		  ('%[1]s', 'Eventos', 'E1', '{"Descripcion_Hecho": "Reunión clave %[2]s", "Fecha": "2026-02-03",
		     "Actor_Principal": "asociación clave %[2]s"}', 'interno', now(), '2026-01-02Z'),
		  ('%[1]s', 'Alertas', 'R1', '{"Causa": "Alerta clave %[2]s", "Fecha": "2026-02-04"}', 'restringido', now(), '2026-01-03Z');
		INSERT INTO record_links (tenant_id, link_type, source_module, source_id, target_module, target_id,
		  note, created_by, created_at) VALUES
		  ('%[1]s', 'origina', 'Eventos', 'E1', 'Alertas', 'R1', 'nota %[2]s', 'tester', '2026-01-04T05:06:07.890Z');`,
		tenant, tag)
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
		  ('solo',   'Solo Analyst', 'x', 'analista', true, true),
		  ('reader', 'Read Only',    'x', 'consulta', true, true),
		  ('multi',  'Multi Admin',  'x', 'admin',    true, true);
		INSERT INTO grants (username, tenant_id) VALUES
		  ('solo','SIPGES/PRJ-SECHURA'), ('reader','SIPGES/PRJ-SECHURA'),
		  ('multi','SIPGES/PRJ-SECHURA'), ('multi','ACME/NORTE');`); err != nil {
		return err
	}
	if err := tenantRows(ctx, conn, "SIPGES/PRJ-SECHURA", rows("SIPGES/PRJ-SECHURA", "PROPIA")); err != nil {
		return fmt.Errorf("sechura: %w", err)
	}
	if err := tenantRows(ctx, conn, "ACME/NORTE", rows("ACME/NORTE", "AJENA")); err != nil {
		return fmt.Errorf("norte: %w", err)
	}
	batch := &pgx.Batch{}
	for _, user := range []string{"solo", "reader", "multi"} {
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
	h, err := app.NewHandler(pool, app.Options{Logger: slog.New(slog.DiscardHandler), Now: func() time.Time { return t0 }})
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
	actor  = `{"module":"actores","id":"A1","type_label":"Actor","title":"Asociación clave PROPIA","date":null,"marking":"interno","fields":{}}`
	event  = `{"module":"eventos","id":"E1","type_label":"Evento","title":"Reunión clave PROPIA","date":"2026-02-03","marking":"interno","fields":{}}`
	alert  = `{"module":"alertas","id":"R1","type_label":"Alerta","title":"Alerta clave PROPIA","date":"2026-02-04","marking":"restringido","fields":{}}`
	origin = `{"id":1,"link_type":"origina","source":{"module":"eventos","id":"E1"},"target":{"module":"alertas","id":"R1"},"inferred":false,"via":null,"note":"nota PROPIA","created_by":"tester","created_at":"2026-01-04T05:06:07Z","evidence":null,"evidence_status":"undocumented"}`
	takes  = `{"id":null,"link_type":"participa_en","source":{"module":"actores","id":"A1"},"target":{"module":"eventos","id":"E1"},"inferred":true,"via":"Actor_Principal","note":"","created_by":null,"created_at":null,"evidence":null,"evidence_status":"undocumented"}`
)

func TestReadsOnlyTheResolvedProjectsRecordsAndLinks(t *testing.T) {
	base := start(t)
	status, body := get(t, base, "/system/search?q=clave", "solo", nil)
	expect(t, status, body, http.StatusOK, `{"query":"clave","hits":[`+
		// E1 holds the term twice (description and actor), so ts_rank puts it first.
		strings.TrimSuffix(event, "}")+`,"match":{"field":"Descripcion_Hecho","excerpt":"Reunión clave PROPIA"},"semantic":false},`+
		strings.TrimSuffix(alert, "}")+`,"match":{"field":"Causa","excerpt":"Alerta clave PROPIA"},"semantic":false},`+
		strings.TrimSuffix(actor, "}")+`,"match":{"field":"Nombre_Actor/Organizacion","excerpt":"Asociación clave PROPIA"},"semantic":false}]}`)

	status, body = get(t, base, "/system/links?module=eventos&id=E1", "solo", nil)
	expect(t, status, body, http.StatusOK, `{"record":`+event+`,"links":[`+
		`{"edge":`+origin+`,"direction":"out","label":"origina","other":`+alert+`},`+
		`{"edge":`+takes+`,"direction":"in","label":"tiene como participante a","other":`+actor+`}]}`)

	status, body = get(t, base, "/system/timeline?from=2026", "solo", nil)
	expect(t, status, body, http.StatusOK, `{"from":"2026-01-01","to":"9999-12-31","entries":[`+alert+`,`+event+`],"truncated":false}`)

	// The other tenant reuses every id; through its own scope it sees only its rows.
	status, body = get(t, base, "/system/search?q=clave", "multi", map[string]string{"X-SIPGES-Scope": "ACME/NORTE"})
	if status != http.StatusOK || strings.Contains(body, "PROPIA") || !strings.Contains(body, "AJENA") {
		t.Fatalf("norte search: %d %s", status, body)
	}
	status, body = get(t, base, "/system/graph?module=eventos&id=E1&depth=2", "multi", map[string]string{"X-SIPGES-Scope": "ACME/NORTE"})
	if status != http.StatusOK || strings.Contains(body, "PROPIA") || !strings.Contains(body, "nota AJENA") {
		t.Fatalf("norte graph: %d %s", status, body)
	}
}

func TestReadOnlyRoleNeverSeesRestrictedRecords(t *testing.T) {
	base := start(t)
	status, body := get(t, base, "/system/search?q=clave", "reader", nil)
	if status != http.StatusOK || strings.Contains(body, "R1") {
		t.Fatalf("search: %d %s", status, body)
	}
	status, body = get(t, base, "/system/links?module=eventos&id=E1", "reader", nil)
	expect(t, status, body, http.StatusOK, `{"record":`+event+`,"links":[`+
		`{"edge":`+takes+`,"direction":"in","label":"tiene como participante a","other":`+actor+`}]}`)
	status, body = get(t, base, "/system/graph?module=alertas&id=R1", "reader", nil)
	expect(t, status, body, http.StatusNotFound, `{"detail":"Registro no encontrado"}`)
	status, body = get(t, base, "/system/timeline?from=2026", "reader", nil)
	expect(t, status, body, http.StatusOK, `{"from":"2026-01-01","to":"9999-12-31","entries":[`+event+`],"truncated":false}`)
}

func TestRefusesRequestsOutsideTheScope(t *testing.T) {
	base := start(t)
	for _, path := range []string{"/system/ontology", "/system/search?q=clave", "/system/timeline", "/system/links?module=eventos&id=E1", "/system/graph?module=eventos&id=E1"} {
		t.Run(path, func(t *testing.T) {
			status, body := get(t, base, path, "", nil)
			expect(t, status, body, http.StatusUnauthorized, `{"detail":"Inicie sesión para acceder a SIPGES"}`)
			status, _ = get(t, base, path, "solo", map[string]string{"X-SIPGES-Scope": "ACME/NORTE"})
			if status != http.StatusForbidden {
				t.Fatalf("ungranted scope: %d", status)
			}
			glue := "?"
			if strings.Contains(path, "?") {
				glue = "&"
			}
			status, body = get(t, base, path+glue+"project_id=NORTE", "solo", nil)
			expect(t, status, body, http.StatusForbidden, `{"detail":"Proyecto fuera de alcance"}`)
		})
	}
}
