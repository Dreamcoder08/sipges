package http_test

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/app/apitest"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/identity/infrastructure"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/database/dbtest"
)

// The integration read routes against a migrated synthetic PostgreSQL, through the composed
// handler (session, project scope, role gate). Every account, project, key and feed is synthetic.

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

// leak marks every stored key hash: no answer may ever contain it.
const leak = "HASH-SINTETICO-NUNCA-SALE"

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

func seed(ctx context.Context, dsn string) error {
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		return err
	}
	defer func() { _ = conn.Close(ctx) }()
	// api_keys is global (no RLS): the other tenant's key reuses a name and only the tenant
	// filter keeps it out.
	if _, err := conn.Exec(ctx, `
		INSERT INTO tenants (company_id, project_id, label) VALUES
		  ('SIPGES','PRJ-SECHURA','Sechura'), ('ACME','NORTE','Norte') ON CONFLICT DO NOTHING;
		INSERT INTO users (username, full_name, password_hash, role, active, totp_enabled) VALUES
		  ('multi',  'Multi Admin',  'x', 'admin',    true, true),
		  ('solo',   'Solo Analyst', 'x', 'analista', true, true),
		  ('reader', 'Read Only',    'x', 'consulta', true, true);
		INSERT INTO grants (username, tenant_id) VALUES
		  ('multi','SIPGES/PRJ-SECHURA'), ('multi','ACME/NORTE'),
		  ('solo','SIPGES/PRJ-SECHURA'), ('reader','SIPGES/PRJ-SECHURA');
		INSERT INTO api_keys (id, tenant_id, name, prefix, secret_hash, access, clearance, created_by,
		  created_at, last_used_at, revoked_at) OVERRIDING SYSTEM VALUE VALUES
		  (11,'SIPGES/PRJ-SECHURA','Zeta','aaaaaaaaaaa1','`+leak+`','read','limited','multi',
		   '2026-10-01T08:00:00.987Z',NULL,NULL),
		  (12,'SIPGES/PRJ-SECHURA','Alfa','aaaaaaaaaaa2','`+leak+`','write','full','multi',
		   '2026-09-01T00:00:00Z','2026-09-02T00:00:00Z','2026-09-03T10:11:12.5Z'),
		  (13,'SIPGES/PRJ-SECHURA','Beta','aaaaaaaaaaa3','`+leak+`','write','full','multi',
		   '2026-10-02T00:00:00Z','2026-10-30T12:00:00.999Z',NULL),
		  (21,'ACME/NORTE','Zeta','bbbbbbbbbbb1','`+leak+`','write','full','multi',
		   '2026-10-01T00:00:00Z',NULL,NULL);`); err != nil {
		return err
	}
	sechura := `
		INSERT INTO media_feeds (tenant_id, id, name, url, keywords, territory, authorization_note, enabled,
		  updated_by, updated_at, last_poll_at, last_poll_error, last_imported, last_matched) OVERRIDING SYSTEM VALUE VALUES
		  ('SIPGES/PRJ-SECHURA',2,'Diario B','https://example.org/b.xml','[]','','Nota',false,'multi',
		   '2026-10-03T00:00:00Z',NULL,'',0,0),
		  ('SIPGES/PRJ-SECHURA',1,'Diario A','https://example.org/a.xml?x=1&y=2','["agua","minería"]','Costa','Autorizado',true,'multi',
		   '2026-10-01T08:00:00.123456Z','2026-10-02T09:30:00.5Z','La fuente no respondió a tiempo.',3,5);
		INSERT INTO source_import_settings (tenant_id, source_id, enabled, query, territory, authorization_note,
		  revision, updated_by, updated_at, last_poll_at, last_poll_error, last_imported, last_duplicates) VALUES
		  ('SIPGES/PRJ-SECHURA','defensoria',true,'agua','Costa','Convenio sintético',3,'multi',
		   '2026-10-04T05:06:07.089Z','2026-10-05T00:00:00Z','source_poll_failed',2,1);`
	if err := tenantRows(ctx, conn, "SIPGES/PRJ-SECHURA", sechura); err != nil {
		return fmt.Errorf("sechura: %w", err)
	}
	// Another tenant reuses the feed id: only RLS keeps it out of Sechura.
	norte := `
		INSERT INTO media_feeds (tenant_id, id, name, url, keywords, territory, authorization_note, enabled,
		  updated_by, updated_at) OVERRIDING SYSTEM VALUE VALUES
		  ('ACME/NORTE',1,'Norte secreto','https://example.org/norte.xml','["norte"]','','Norte',true,'multi',
		   '2026-10-01T00:00:00Z');`
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
	return apitest.Start(t, scratch, t0)
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
	body := strings.TrimSpace(string(b))
	if strings.Contains(body, leak) || strings.Contains(body, `"secret_hash"`) || strings.Contains(body, `"token"`) {
		t.Fatalf("%s: answer exposes a key hash: %s", path, body)
	}
	return res.StatusCode, body
}

var expect = apitest.Expect

const (
	keysSechura = `[` +
		`{"id":13,"name":"Beta","prefix":"aaaaaaaaaaa3","access":"write","clearance":"full","created_by":"multi","created_at":"2026-10-02T00:00:00Z","last_used_at":"2026-10-30T12:00:00Z","revoked_at":null},` +
		`{"id":11,"name":"Zeta","prefix":"aaaaaaaaaaa1","access":"read","clearance":"limited","created_by":"multi","created_at":"2026-10-01T08:00:00Z","last_used_at":null,"revoked_at":null},` +
		`{"id":12,"name":"Alfa","prefix":"aaaaaaaaaaa2","access":"write","clearance":"full","created_by":"multi","created_at":"2026-09-01T00:00:00Z","last_used_at":"2026-09-02T00:00:00Z","revoked_at":"2026-09-03T10:11:12Z"}]`
	keysNorte    = `[{"id":21,"name":"Zeta","prefix":"bbbbbbbbbbb1","access":"write","clearance":"full","created_by":"multi","created_at":"2026-10-01T00:00:00Z","last_used_at":null,"revoked_at":null}]`
	mediaSechura = `{"poll_minutes":30,"max_feeds":20,"feeds":[` +
		`{"id":1,"name":"Diario A","url":"https://example.org/a.xml?x=1\u0026y=2","keywords":["agua","minería"],"territory":"Costa","authorization_note":"Autorizado","enabled":true,"updated_by":"multi","updated_at":"2026-10-01T08:00:00.123Z","last_poll_at":"2026-10-02T09:30:00.500Z","last_poll_error":"La fuente no respondió a tiempo.","last_imported":3,"last_matched":5},` +
		`{"id":2,"name":"Diario B","url":"https://example.org/b.xml","keywords":[],"territory":"","authorization_note":"Nota","enabled":false,"updated_by":"multi","updated_at":"2026-10-03T00:00:00.000Z","last_poll_at":null,"last_poll_error":"","last_imported":0,"last_matched":0}]}`
	mediaNorte = `{"poll_minutes":30,"max_feeds":20,"feeds":[` +
		`{"id":1,"name":"Norte secreto","url":"https://example.org/norte.xml","keywords":["norte"],"territory":"","authorization_note":"Norte","enabled":true,"updated_by":"multi","updated_at":"2026-10-01T00:00:00.000Z","last_poll_at":null,"last_poll_error":"","last_imported":0,"last_matched":0}]}`
	catalogHead    = `{"id":"defensoria","name":"Defensoría del Pueblo del Perú","url":"https://www.defensoria.gob.pe/","checked_at":"2026-10-17","attribution":"Publicaciones oficiales de la Defensoría del Pueblo. Solo título y extracto; disponibilidad externa variable. Pendientes de verificación.","state":` //nolint:misspell // Spanish text of authorized-sources.ts
	sourcesSechura = catalogHead + `{"enabled":true,"query":"agua","territory":"Costa","authorization_note":"Convenio sintético","revision":3,"updated_by":"multi","updated_at":"2026-10-04T05:06:07.089Z","last_poll_at":"2026-10-05T00:00:00.000Z","last_poll_error":"source_poll_failed","last_imported":2,"last_duplicates":1}}`
	sourcesNorte   = catalogHead + `{"enabled":false,"query":"","territory":"","authorization_note":"","revision":0,"updated_by":"","updated_at":null,"last_poll_at":null,"last_poll_error":"","last_imported":0,"last_duplicates":0}}`

	signIn     = `{"detail":"Inicie sesión para acceder a SIPGES"}`
	adminOnly  = `{"detail":"Requiere rol administrador"}`
	outOfScope = `{"detail":"Proyecto fuera de alcance"}`
	choose     = `{"detail":"Seleccione un proyecto autorizado mediante X-SIPGES-Scope o /select-project","projects":["ACME/NORTE","SIPGES/PRJ-SECHURA"]}`
	chooseSolo = `{"detail":"Seleccione un proyecto autorizado mediante X-SIPGES-Scope o /select-project","projects":["SIPGES/PRJ-SECHURA"]}`
	notFound   = `{"detail":"Not Found"}`
)

var (
	sechuraScope = map[string]string{"X-SIPGES-Scope": "SIPGES/PRJ-SECHURA"}
	norteScope   = map[string]string{"X-SIPGES-Scope": "ACME/NORTE"}
)

func TestAPIKeysListOnlyTheProjectsMetadataToAdministrators(t *testing.T) {
	base := start(t)
	const path = "/system/integrations/api-keys"
	status, body := get(t, base, path, "multi", sechuraScope)
	expect(t, status, body, http.StatusOK, keysSechura)
	status, body = get(t, base, path+"?project_id=PRJ-SECHURA", "multi", sechuraScope)
	expect(t, status, body, http.StatusOK, keysSechura)
	// Same key name in another tenant: each project sees its own key only.
	status, body = get(t, base, path, "multi", norteScope)
	expect(t, status, body, http.StatusOK, keysNorte)
	for _, user := range []string{"solo", "reader"} {
		status, body = get(t, base, path, user, nil)
		expect(t, status, body, http.StatusForbidden, adminOnly)
	}
}

func TestMediaAndSourcesServeTheResolvedProjectToEveryRole(t *testing.T) {
	base := start(t)
	for _, c := range []struct{ path, sechura, norte string }{
		{"/system/v4/media", mediaSechura, mediaNorte},
		{"/system/intelligence/sources", sourcesSechura, sourcesNorte},
	} {
		t.Run(c.path, func(t *testing.T) {
			for _, user := range []string{"solo", "reader"} {
				status, body := get(t, base, c.path, user, nil)
				expect(t, status, body, http.StatusOK, c.sechura)
			}
			status, body := get(t, base, c.path+"?project_id=PRJ-SECHURA", "solo", nil)
			expect(t, status, body, http.StatusOK, c.sechura)
			status, body = get(t, base, c.path, "multi", sechuraScope)
			expect(t, status, body, http.StatusOK, c.sechura)
			// The other tenant reuses the feed id; RLS keeps each project's rows apart.
			status, body = get(t, base, c.path, "multi", norteScope)
			expect(t, status, body, http.StatusOK, c.norte)
		})
	}
}

func TestRefusesIntegrationReadsOutsideTheScope(t *testing.T) {
	base := start(t)
	for _, path := range []string{"/system/integrations/api-keys", "/system/v4/media", "/system/intelligence/sources"} {
		t.Run(path, func(t *testing.T) {
			status, body := get(t, base, path, "", nil)
			expect(t, status, body, http.StatusUnauthorized, signIn)
			status, body = get(t, base, path, "multi", nil)
			expect(t, status, body, http.StatusForbidden, choose)
			status, body = get(t, base, path+"?project_id=NORTE", "multi", sechuraScope)
			expect(t, status, body, http.StatusForbidden, outOfScope)
			status, body = get(t, base, path+"/", "multi", sechuraScope)
			expect(t, status, body, http.StatusNotFound, notFound)
		})
	}
	for _, path := range []string{"/system/v4/media", "/system/intelligence/sources"} {
		status, body := get(t, base, path, "solo", norteScope)
		expect(t, status, body, http.StatusForbidden, chooseSolo)
	}
}
