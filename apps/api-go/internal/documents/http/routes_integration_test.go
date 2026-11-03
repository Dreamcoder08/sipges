//nolint:misspell // Spanish module slugs, labels and themes, verbatim from the TypeScript API.
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

// GET /system/document-lab/review against a migrated synthetic PostgreSQL, through the composed
// handler (session, project scope, role gate). Every account, project, finding and record is
// synthetic.

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

func finding(tenant, id, project, theme, status, reviewer, note, created, updated string) string {
	return fmt.Sprintf(`('%s','%s','%s','acta.pdf','%s','página 1','%s','Texto %s','Revisar %s','%s','%s','%s','%s','%s')`,
		tenant, id, project, sha, theme, id, id, status, reviewer, note, created, updated)
}

func record(tenant, module, id, marking string) string {
	return fmt.Sprintf(`('%s','%s','%s','{"Asunto":"x"}'::jsonb,'%s','2026-10-01T00:00:00Z','2026-10-01T00:00:00Z')`,
		tenant, module, id, marking)
}

const insertFindings = `INSERT INTO document_review (tenant_id, id, project_id, source_file, source_sha256,
  location, theme, excerpt, action, status, reviewer, note, created_at, updated_at) VALUES `

const insertRecords = `INSERT INTO module_records (tenant_id, module, id, payload, marking, created_at, updated_at) VALUES `

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
	sechura := insertFindings + strings.Join([]string{
		finding(s, "R1", "PRJ-SECHURA", "Territorio y ambiente", "aceptado_para_revision", "solo", "", "2026-10-03T10:00:00.900Z", "2026-10-04T08:00:00Z"),
		// Same instant as R1: the id breaks the tie, descending.
		finding(s, "R0", "PRJ-SECHURA", "10", "descartado", "solo", "No aplica", "2026-10-03T10:00:00.900Z", "2026-10-04T09:00:00Z"),
		finding(s, "R2", "PRJ-SECHURA", "Demandas e intereses", "corroborado_documentalmente", "solo", "Acta contrastada", "2026-10-02T09:00:00Z", "2026-10-02T10:00:00Z"),
		// Approved before its record existed: no link until the backfill.
		finding(s, "R3", "PRJ-SECHURA", "Hallazgo libre", "aceptado_para_revision", "solo", "", "2026-10-01T12:00:00Z", "2026-10-01T12:00:00Z"),
		// Pending: never linked, even though a record with its id exists.
		finding(s, "R4", "PRJ-SECHURA", "Demandas e intereses", "pendiente", "", "", "2026-10-01T08:00:00Z", "2026-10-01T08:00:00Z"),
		// Its record sits in another module than its theme's: no link.
		finding(s, "R7", "PRJ-SECHURA", "Representatividad y gobernanza", "aceptado_para_revision", "solo", "", "2026-09-30T00:00:00Z", "2026-09-30T00:00:00Z"),
		// Same tenant, another project id: the project filter hides it.
		finding(s, "RX", "OTHER", "Territorio y ambiente", "aceptado_para_revision", "solo", "", "2026-10-05T00:00:00Z", "2026-10-05T00:00:00Z"),
	}, ",") + ";" + insertRecords + strings.Join([]string{
		record(s, "Narrativas", "REV-R1", "interno"),
		// Restricted: the read-only role does not see the record, so the item has no link.
		record(s, "Demandas", "REV-R2", "restringido"),
		record(s, "Demandas", "REV-R4", "interno"),
		record(s, "Hechos_Compartidos", "REV-R7", "interno"),
	}, ",") + ";"
	if err := tenantRows(ctx, conn, s, sechura); err != nil {
		return fmt.Errorf("sechura: %w", err)
	}
	// Another tenant reuses the ids and even the project id: only RLS keeps it out of Sechura.
	const n = "ACME/NORTE"
	norte := insertFindings + strings.Join([]string{
		finding(n, "R1", "NORTE", "Norte", "aceptado_para_revision", "multi", "", "2026-10-06T00:00:00Z", "2026-10-06T00:00:00Z"),
		finding(n, "R9", "PRJ-SECHURA", "Territorio y ambiente", "aceptado_para_revision", "multi", "", "2026-10-07T00:00:00Z", "2026-10-07T00:00:00Z"),
	}, ",") + ";" + insertRecords + strings.Join([]string{
		record(n, "Hechos_Compartidos", "REV-R1", "interno"),
		record(n, "Narrativas", "REV-R9", "interno"),
	}, ",") + ";"
	if err := tenantRows(ctx, conn, n, norte); err != nil {
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

// item is one finding as reviewJson writes it.
func item(id, project, theme, status, reviewer, note, created, updated, target, record string) string {
	return fmt.Sprintf(`{"id":"%s","project_id":"%s","source_file":"acta.pdf","source_sha256":"%s","location":"página 1",`+
		`"theme":"%s","excerpt":"Texto %s","action":"Revisar %s","status":"%s","reviewer":"%s","note":"%s",`+
		`"created_at":"%s","updated_at":"%s","target":%s,"record":%s}`,
		id, project, sha, theme, id, id, status, reviewer, note, created, updated, target, record)
}

func page(items []string, total, limit, offset int, themes string) string {
	return fmt.Sprintf(`{"items":[%s],"total":%d,"limit":%d,"offset":%d,"themes":%s,"limitations":"Revisado no implica verdad certificada: comprobar fuente y documentación."}`,
		strings.Join(items, ","), total, limit, offset, themes)
}

const (
	narrativas = `{"module":"narrativas","label":"Narrativas"}`
	demandas   = `{"module":"demandas","label":"Demandas"}`
	hechos     = `{"module":"hechos","label":"Hechos compartidos"}`
	actores    = `{"module":"actores","label":"Actores"}`
	noRecord   = `null`
)

var (
	r1 = item("R1", "PRJ-SECHURA", "Territorio y ambiente", "aceptado_para_revision", "solo", "", "2026-10-03T10:00:00Z", "2026-10-04T08:00:00Z",
		narrativas, `{"module":"narrativas","id":"REV-R1"}`)
	r0 = item("R0", "PRJ-SECHURA", "10", "descartado", "solo", "No aplica", "2026-10-03T10:00:00Z", "2026-10-04T09:00:00Z", hechos, noRecord)
	r2 = item("R2", "PRJ-SECHURA", "Demandas e intereses", "corroborado_documentalmente", "solo", "Acta contrastada", "2026-10-02T09:00:00Z", "2026-10-02T10:00:00Z",
		demandas, `{"module":"demandas","id":"REV-R2"}`)
	r2Limited = item("R2", "PRJ-SECHURA", "Demandas e intereses", "corroborado_documentalmente", "solo", "Acta contrastada", "2026-10-02T09:00:00Z", "2026-10-02T10:00:00Z",
		demandas, noRecord)
	r3 = item("R3", "PRJ-SECHURA", "Hallazgo libre", "aceptado_para_revision", "solo", "", "2026-10-01T12:00:00Z", "2026-10-01T12:00:00Z", hechos, noRecord)
	r4 = item("R4", "PRJ-SECHURA", "Demandas e intereses", "pendiente", "", "", "2026-10-01T08:00:00Z", "2026-10-01T08:00:00Z", demandas, noRecord)
	r7 = item("R7", "PRJ-SECHURA", "Representatividad y gobernanza", "aceptado_para_revision", "solo", "", "2026-09-30T00:00:00Z", "2026-09-30T00:00:00Z", actores, noRecord)

	allThemes = `{"10":1,"Demandas e intereses":2,"Hallazgo libre":1,"Representatividad y gobernanza":1,"Territorio y ambiente":1}`

	sechura = page([]string{r1, r0, r2, r3, r4, r7}, 6, 50, 0, allThemes)
	limited = page([]string{r1, r0, r2Limited, r3, r4, r7}, 6, 50, 0, allThemes)
	norte   = page([]string{item("R1", "NORTE", "Norte", "aceptado_para_revision", "multi", "", "2026-10-06T00:00:00Z", "2026-10-06T00:00:00Z",
		hechos, `{"module":"hechos","id":"REV-R1"}`)}, 1, 50, 0, `{"Norte":1}`)
)

const (
	path          = "/system/document-lab/review"
	signIn        = `{"detail":"Inicie sesión para acceder a SIPGES"}`
	outOfScope    = `{"detail":"Proyecto fuera de alcance"}`
	choose        = `{"detail":"Seleccione un proyecto autorizado mediante X-SIPGES-Scope o /select-project","projects":["ACME/NORTE","SIPGES/PRJ-SECHURA"]}`
	chooseSolo    = `{"detail":"Seleccione un proyecto autorizado mediante X-SIPGES-Scope o /select-project","projects":["SIPGES/PRJ-SECHURA"]}`
	notFound      = `{"detail":"Not Found"}`
	invalidLimit  = `{"detail":"Parámetro limit inválido: use un entero de 1 a 200"}`
	invalidOffset = `{"detail":"Parámetro offset inválido: use un entero mayor o igual a 0"}`
)

func TestServesTheInboxOfTheResolvedProject(t *testing.T) {
	base := start(t)
	status, body := get(t, base, path, "solo", nil)
	expect(t, status, body, http.StatusOK, sechura)
	status, body = get(t, base, path+"?project_id=PRJ-SECHURA", "solo", nil)
	expect(t, status, body, http.StatusOK, sechura)
	status, body = get(t, base, path, "multi", map[string]string{"X-SIPGES-Scope": "SIPGES/PRJ-SECHURA"})
	expect(t, status, body, http.StatusOK, sechura)
	// A two-project user sees each project's findings and records only.
	status, body = get(t, base, path, "multi", map[string]string{"X-SIPGES-Scope": "ACME/NORTE"})
	expect(t, status, body, http.StatusOK, norte)
}

func TestTheReadOnlyRoleNeverSeesARestrictedRecord(t *testing.T) {
	base := start(t)
	status, body := get(t, base, path, "reader", nil)
	expect(t, status, body, http.StatusOK, limited)
}

func TestFiltersAndPages(t *testing.T) {
	base := start(t)
	for _, c := range []struct{ query, want string }{
		{"?status=pendiente", page([]string{r4}, 1, 50, 0, `{"Demandas e intereses":1}`)},
		{"?theme=Demandas+e+intereses", page([]string{r2, r4}, 2, 50, 0, allThemes)},
		{"?status=aceptado_para_revision&theme=Hallazgo%20libre", page([]string{r3}, 1, 50, 0,
			`{"Hallazgo libre":1,"Representatividad y gobernanza":1,"Territorio y ambiente":1}`)},
		{"?limit=2&offset=1", page([]string{r0, r2}, 6, 2, 1, allThemes)},
		{"?limit=0200&offset=6", page(nil, 6, 200, 6, allThemes)},
		{"?offset=9007199254740991", page(nil, 6, 50, 9007199254740991, allThemes)},
		// Empty filters mean any.
		{"?status=&theme=", sechura},
		{"?status=nada", page(nil, 0, 50, 0, `{}`)},
		// Text PostgreSQL cannot hold matches nothing.
		{"?theme=%00", page(nil, 0, 50, 0, `{}`)},
		{"?status=a%00", page(nil, 0, 50, 0, `{}`)},
	} {
		t.Run(c.query, func(t *testing.T) {
			status, body := get(t, base, path+c.query, "solo", nil)
			expect(t, status, body, http.StatusOK, c.want)
		})
	}
}

func TestRefusesInvalidPages(t *testing.T) {
	base := start(t)
	for query, want := range map[string]string{
		"?limit=0":                     invalidLimit,
		"?limit=201":                   invalidLimit,
		"?limit=":                      invalidLimit,
		"?limit":                       invalidLimit,
		"?limit=1.5":                   invalidLimit,
		"?limit=-1":                    invalidLimit,
		"?limit=%2B5":                  invalidLimit,
		"?limit=0&offset=-1":           invalidLimit,
		"?offset=-1":                   invalidOffset,
		"?offset=abc":                  invalidOffset,
		"?offset=9007199254740992":     invalidOffset,
		"?offset=1e3":                  invalidOffset,
		"?limit=10&offset=":            invalidOffset,
		"?offset=99999999999999999999": invalidOffset,
	} {
		t.Run(query, func(t *testing.T) {
			status, body := get(t, base, path+query, "solo", nil)
			expect(t, status, body, http.StatusUnprocessableEntity, want)
		})
	}
}

func TestRefusesRequestsOutsideTheScope(t *testing.T) {
	base := start(t)
	status, body := get(t, base, path, "", nil)
	expect(t, status, body, http.StatusUnauthorized, signIn)
	status, body = get(t, base, path, "solo", map[string]string{"X-SIPGES-Scope": "ACME/NORTE"})
	expect(t, status, body, http.StatusForbidden, chooseSolo)
	status, body = get(t, base, path+"?project_id=NORTE", "solo", nil)
	expect(t, status, body, http.StatusForbidden, outOfScope)
	// The project check comes before the page check.
	status, body = get(t, base, path+"?project_id=NORTE&limit=0", "solo", nil)
	expect(t, status, body, http.StatusForbidden, outOfScope)
	status, body = get(t, base, path, "multi", nil)
	expect(t, status, body, http.StatusForbidden, choose)
	status, body = get(t, base, path+"/", "solo", nil)
	expect(t, status, body, http.StatusNotFound, notFound)
}
