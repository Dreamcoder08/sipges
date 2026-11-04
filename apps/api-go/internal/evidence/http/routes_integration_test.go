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

// The evidence metadata read routes against a migrated synthetic PostgreSQL, through the
// composed handler (session, project scope, role gate, tenant transaction). Every account,
// project, record and attachment is synthetic; no object storage is involved.

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

const (
	shaA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	shaB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
)

// tenantRows inserts one tenant's rows inside a transaction entered as that tenant.
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

// attachment is one attachments row of tenant linked to (module, record).
func attachment(tenant, id, name, slug, module, record, docType, author, notes, project, projectName, created string, size int, sha string) string {
	return fmt.Sprintf(`INSERT INTO attachments (tenant_id, id, storage_key, original_name, content_type,
		size_bytes, sha256, linked_module, record_module, linked_record_id, document_type, author,
		verification, notes, project_id, project_name, created_at) VALUES
		('%[1]s', '%[2]s', '%[1]s/%[2]s', '%[3]s', 'application/pdf', %[13]d, '%[14]s', '%[4]s', '%[5]s',
		 '%[6]s', '%[7]s', '%[8]s', 'E - No verificada', '%[9]s', '%[10]s', '%[11]s', '%[12]s');`,
		tenant, id, name, slug, module, record, docType, author, notes, project, projectName, created, size, sha)
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
	const records = `INSERT INTO module_records (tenant_id, module, id, payload, marking, created_at, updated_at) VALUES
		(current_setting('app.tenant_id'), 'Eventos', 'EV-1', '{}', 'interno', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
		(current_setting('app.tenant_id'), 'Fuentes', 'F-1', '{}', 'publico', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
		(current_setting('app.tenant_id'), 'Alertas', 'AL-R', '{}', 'restringido', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');`
	const s = "SIPGES/PRJ-SECHURA"
	sechura := records +
		attachment(s, "ADJ-1", "acta.pdf", "eventos", "Eventos", "EV-1", "Acta", "Equipo", "Firmada 100% al_fin", "PRJ-SECHURA", "Proyecto Sechura", "2026-10-01T08:00:00.900Z", 10, shaA) +
		attachment(s, "ADJ-2", "foto.pdf", "eventos", "Eventos", "EV-1", "Reporte / evidencia", "", "", "PRJ-SECHURA", "Proyecto Sechura", "2026-10-02T09:00:00Z", 20, shaB) +
		attachment(s, "ADJ-3", "fuente.pdf", "fuentes", "Fuentes", "F-1", "Nota", "Prensa", "", "PRJ-SECHURA", "", "2026-10-02T09:00:00Z", 30, shaA) +
		// Linked to a restricted record: only full clearance sees it.
		attachment(s, "ADJ-R", "reservado.pdf", "alertas", "Alertas", "AL-R", "Reservado", "", "", "PRJ-SECHURA", "Proyecto Sechura", "2026-10-03T00:00:00Z", 40, shaA)
	if err := tenantRows(ctx, conn, s, sechura); err != nil {
		return fmt.Errorf("sechura: %w", err)
	}
	// Another tenant reuses the ids, the record and the project id: only RLS keeps it out.
	const n = "ACME/NORTE"
	norte := records +
		attachment(n, "ADJ-1", "norte.pdf", "eventos", "Eventos", "EV-1", "Acta", "Norte", "secreto", "PRJ-SECHURA", "Norte", "2026-10-04T00:00:00Z", 50, shaB) +
		attachment(n, "ADJ-N", "solo-norte.pdf", "eventos", "Eventos", "EV-1", "Acta", "Norte", "", "NORTE", "Norte", "2026-10-04T00:00:00Z", 60, shaB)
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

// js is the JSON toJson of evidence-routes.ts writes for one attachment.
func js(id, name string, size int, sha, slug, record, docType, author, notes, project, projectName, created string) string {
	return fmt.Sprintf(`{"id":%[1]q,"original_name":%[2]q,"content_type":"application/pdf","size_bytes":%[3]d,`+
		`"sha256":%[4]q,"linked_module":%[5]q,"linked_record_id":%[6]q,"document_type":%[7]q,"author":%[8]q,`+
		`"verification":"E - No verificada","notes":%[9]q,"project_id":%[10]q,"project_name":%[11]q,`+
		`"Proyecto_ID":%[10]q,"Proyecto":%[11]q,"created_at":%[12]q,"download_url":"/system/uploads/%[1]s/download"}`,
		id, name, size, sha, slug, record, docType, author, notes, project, projectName, created)
}

var (
	adj1  = js("ADJ-1", "acta.pdf", 10, shaA, "eventos", "EV-1", "Acta", "Equipo", "Firmada 100% al_fin", "PRJ-SECHURA", "Proyecto Sechura", "2026-10-01T08:00:00Z")
	adj2  = js("ADJ-2", "foto.pdf", 20, shaB, "eventos", "EV-1", "Reporte / evidencia", "", "", "PRJ-SECHURA", "Proyecto Sechura", "2026-10-02T09:00:00Z")
	adj3  = js("ADJ-3", "fuente.pdf", 30, shaA, "fuentes", "F-1", "Nota", "Prensa", "", "PRJ-SECHURA", "", "2026-10-02T09:00:00Z")
	adjR  = js("ADJ-R", "reservado.pdf", 40, shaA, "alertas", "AL-R", "Reservado", "", "", "PRJ-SECHURA", "Proyecto Sechura", "2026-10-03T00:00:00Z")
	adjN  = js("ADJ-N", "solo-norte.pdf", 60, shaB, "eventos", "EV-1", "Acta", "Norte", "", "NORTE", "Norte", "2026-10-04T00:00:00Z")
	adjN1 = js("ADJ-1", "norte.pdf", 50, shaB, "eventos", "EV-1", "Acta", "Norte", "secreto", "PRJ-SECHURA", "Norte", "2026-10-04T00:00:00Z")
)

func list(items ...string) string { return "[" + strings.Join(items, ",") + "]" }

const (
	signIn     = `{"detail":"Inicie sesión para acceder a SIPGES"}`
	outOfScope = `{"detail":"Proyecto fuera de alcance"}`
	choose     = `{"detail":"Seleccione un proyecto autorizado mediante X-SIPGES-Scope o /select-project","projects":["ACME/NORTE","SIPGES/PRJ-SECHURA"]}`
	chooseSolo = `{"detail":"Seleccione un proyecto autorizado mediante X-SIPGES-Scope o /select-project","projects":["SIPGES/PRJ-SECHURA"]}`
	notFound   = `{"detail":"Not Found"}`
	noFile     = `{"detail":"Archivo no encontrado"}`
	badLimit   = `{"detail":[{"type":"int_parsing","loc":["query","limit"],"msg":"Input should be a valid integer, unable to parse string as an integer"}]}`
)

func TestListsTheAttachmentsOfTheResolvedProjectNewestFirst(t *testing.T) {
	base := start(t)
	all := list(adjR, adj3, adj2, adj1)
	for _, c := range []struct{ path, user, body string }{
		{"/system/uploads", "solo", all},
		{"/system/uploads?project_id=PRJ-SECHURA", "solo", all},
		// Read-only accounts never see the attachment of a restricted record.
		{"/system/uploads", "reader", list(adj3, adj2, adj1)},
		{"/system/uploads?linked_module=%20EVENTOS%20", "solo", list(adj2, adj1)},
		{"/system/uploads?linked_module=alertas", "reader", list()},
		{"/system/uploads?linked_module=alertas", "solo", list(adjR)},
		{"/system/uploads?linked_record_id=F-1", "solo", list(adj3)},
		{"/system/uploads?linked_module=&linked_record_id=&q=", "solo", all},
		// q is matched literally (LIKE wildcards escaped), case-insensitively, on four fields.
		{"/system/uploads?q=100%25", "solo", list(adj1)},
		{"/system/uploads?q=100_", "solo", list()},
		{"/system/uploads?q=%25", "solo", list(adj1)},
		{"/system/uploads?q=al_fin", "solo", list(adj1)},
		{"/system/uploads?q=PRENSA", "solo", list(adj3)},
		{"/system/uploads?q=evidencia", "solo", list(adj2)},
		{"/system/uploads?q=secreto", "solo", list()},
		// Values PostgreSQL text cannot hold never match.
		{"/system/uploads?q=a%00b", "solo", list()},
		{"/system/uploads?linked_module=%00", "solo", list()},
		// The limit is clamped to 1..500.
		{"/system/uploads?limit=2", "solo", list(adjR, adj3)},
		{"/system/uploads?limit=0", "solo", list(adjR)},
		{"/system/uploads?limit=-9", "solo", list(adjR)},
		{"/system/uploads?limit=%20+3%20", "solo", list(adjR, adj3, adj2)},
		{"/system/uploads?limit=99999999999999999999999", "solo", all},
		// A two-project user sees each project's files only, never the other tenant's.
		{"/system/uploads", "multi", ""},
	} {
		if c.body == "" {
			continue
		}
		status, body := get(t, base, c.path, c.user, nil)
		if status != http.StatusOK || body != c.body {
			t.Errorf("%s as %s:\ngot  %d %s\nwant 200 %s", c.path, c.user, status, body, c.body)
		}
	}
	status, body := get(t, base, "/system/uploads", "multi", map[string]string{"X-SIPGES-Scope": "SIPGES/PRJ-SECHURA"})
	expect(t, status, body, http.StatusOK, all)
	status, body = get(t, base, "/system/uploads", "multi", map[string]string{"X-SIPGES-Scope": "ACME/NORTE"})
	expect(t, status, body, http.StatusOK, list(adjN, adjN1))
}

func TestRefusesAnUnparsableLimit(t *testing.T) {
	base := start(t)
	for _, limit := range []string{"abc", "1.5", "", "1e3", "--1", "%EF%BC%91"} {
		status, body := get(t, base, "/system/uploads?limit="+limit, "solo", nil)
		expect(t, status, body, http.StatusUnprocessableEntity, badLimit)
	}
}

func TestShowsOneAttachmentOfTheResolvedProjectOnly(t *testing.T) {
	base := start(t)
	for _, c := range []struct {
		path, user string
		headers    map[string]string
		status     int
		body       string
	}{
		{"/system/uploads/ADJ-1", "solo", nil, 200, adj1},
		{"/system/uploads/ADJ-1", "reader", nil, 200, adj1},
		{"/system/uploads/ADJ-%31", "solo", nil, 200, adj1},
		{"/system/uploads/ADJ-R", "solo", nil, 200, adjR},
		// Restricted record: the read-only role gets the same 404 as for a missing file.
		{"/system/uploads/ADJ-R", "reader", nil, 404, noFile},
		// Another tenant's id is never served, even when this tenant has none of that name.
		{"/system/uploads/ADJ-N", "solo", nil, 404, noFile},
		{"/system/uploads/ADJ-1", "multi", map[string]string{"X-SIPGES-Scope": "ACME/NORTE"}, 200, adjN1},
		{"/system/uploads/ADJ-N", "multi", map[string]string{"X-SIPGES-Scope": "ACME/NORTE"}, 200, adjN},
		{"/system/uploads/ADJ-3", "multi", map[string]string{"X-SIPGES-Scope": "ACME/NORTE"}, 404, noFile},
		{"/system/uploads/missing", "solo", nil, 404, noFile},
		{"/system/uploads/a%00b", "solo", nil, 404, noFile},
		{"/system/uploads/" + strings.Repeat("A", 65), "solo", nil, 404, noFile},
		{"/system/uploads/a%2Fb", "solo", nil, 404, noFile},
		{"/system/uploads/", "solo", nil, 404, notFound},
	} {
		status, body := get(t, base, c.path, c.user, c.headers)
		if status != c.status || body != c.body {
			t.Errorf("%s as %s %v:\ngot  %d %s\nwant %d %s", c.path, c.user, c.headers, status, body, c.status, c.body)
		}
	}
}

func TestRefusesRequestsOutsideTheScope(t *testing.T) {
	base := start(t)
	for _, path := range []string{"/system/uploads", "/system/uploads/ADJ-1"} {
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
}
