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
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/app"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/identity/infrastructure"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/database/dbtest"
)

// The analytics read routes against a migrated synthetic PostgreSQL, through the composed handler
// (session, project scope, role gate) and the embedded Rust engines. testdata holds the synthetic
// records of apps/parity/src/contexts/analytics.ts (sechura.sql, otro.sql) and the TypeScript
// API's answer to each route on them (JSON.stringify of the TypeScript functions, generated_at
// pinned to t0): full/ as an administrator, limited/ as the read-only role, which must not see
// the record marked 'restringido', and otro/ as a user of the other tenant. The other tenant's
// rows name the default project's id, so only row-level security keeps them out of Sechura.

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

// t0 is the synthetic "now": generated_at is 2026-11-03T11:00:00Z.
var t0 = time.Date(2026, 11, 3, 11, 0, 0, 999_000_000, time.UTC)

var tokens = map[string]string{}

// tenantRows inserts one tenant's rows inside a transaction entered as that tenant, so the
// row-level security policies hold even for a non-superuser test login.
func tenantRows(ctx context.Context, conn *pgx.Conn, tenant, file string) error {
	sql, err := os.ReadFile(filepath.Join("testdata", file))
	if err != nil {
		return err
	}
	tx, err := conn.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenant); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, string(sql)); err != nil {
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
	if _, err := conn.Exec(ctx, `
		INSERT INTO tenants (company_id, project_id, label) VALUES
		  ('SIPGES','PRJ-SECHURA','Sechura'), ('PARITY','OTRO','Proyecto sintético ajeno')
		  ON CONFLICT DO NOTHING;
		INSERT INTO users (username, full_name, password_hash, role, active, totp_enabled) VALUES
		  ('solo',   'Solo Admin',  'x', 'admin',    true, true),
		  ('reader', 'Read Only',   'x', 'consulta', true, true),
		  ('multi',  'Multi Admin', 'x', 'admin',    true, true);
		INSERT INTO grants (username, tenant_id) VALUES
		  ('solo','SIPGES/PRJ-SECHURA'), ('reader','SIPGES/PRJ-SECHURA'),
		  ('multi','SIPGES/PRJ-SECHURA'), ('multi','PARITY/OTRO');`); err != nil {
		return err
	}
	if err := tenantRows(ctx, conn, "SIPGES/PRJ-SECHURA", "sechura.sql"); err != nil {
		return fmt.Errorf("sechura: %w", err)
	}
	if err := tenantRows(ctx, conn, "PARITY/OTRO", "otro.sql"); err != nil {
		return fmt.Errorf("otro: %w", err)
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
	srv := httptest.NewServer(app.NewHandler(pool, app.Options{
		Logger: slog.New(slog.DiscardHandler),
		Now:    func() time.Time { return t0 },
	}))
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
	if ct := res.Header.Get("Content-Type"); ct != "application/json" {
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

func want(t *testing.T, dir, name string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", dir, name+".json"))
	if err != nil {
		t.Fatal(err)
	}
	return strings.TrimSpace(string(b))
}

var routes = []struct{ path, name string }{
	{"/api/dashboard", "dashboard"},
	{"/system/situational-analysis", "situational-analysis"},
	{"/system/strategic-assessment", "strategic-assessment"},
	{"/system/consensus-engine", "consensus-engine"},
	{"/system/integrated-analysis", "integrated-analysis"},
}

const (
	signIn     = `{"detail":"Inicie sesión para acceder a SIPGES"}`
	outOfScope = `{"detail":"Proyecto fuera de alcance"}`
	chooseSolo = `{"detail":"Seleccione un proyecto autorizado mediante X-SIPGES-Scope o /select-project","projects":["SIPGES/PRJ-SECHURA"]}`
)

func TestServesTheAnalysesOfTheResolvedProject(t *testing.T) {
	base := start(t)
	for _, r := range routes {
		t.Run(r.name, func(t *testing.T) {
			status, body := get(t, base, r.path, "solo", nil)
			expect(t, status, body, http.StatusOK, want(t, "full", r.name))
			status, body = get(t, base, r.path+"?project_id=PRJ-SECHURA", "solo", nil)
			expect(t, status, body, http.StatusOK, want(t, "full", r.name))
			// The read-only role reads too, without the record marked 'restringido'.
			status, body = get(t, base, r.path, "reader", nil)
			expect(t, status, body, http.StatusOK, want(t, "limited", r.name))
			// A two-project user sees each tenant's records only; the other tenant's label names
			// its project in the situational analysis.
			status, body = get(t, base, r.path, "multi", map[string]string{"X-SIPGES-Scope": "SIPGES/PRJ-SECHURA"})
			expect(t, status, body, http.StatusOK, want(t, "full", r.name))
			status, body = get(t, base, r.path, "multi", map[string]string{"X-SIPGES-Scope": "PARITY/OTRO"})
			expect(t, status, body, http.StatusOK, want(t, "otro", r.name))
		})
	}
}

func TestRefusesRequestsOutsideTheScope(t *testing.T) {
	base := start(t)
	for _, r := range routes {
		t.Run(r.name, func(t *testing.T) {
			status, body := get(t, base, r.path, "", nil)
			expect(t, status, body, http.StatusUnauthorized, signIn)
			status, body = get(t, base, r.path, "solo", map[string]string{"X-SIPGES-Scope": "PARITY/OTRO"})
			expect(t, status, body, http.StatusForbidden, chooseSolo)
			status, body = get(t, base, r.path+"?project_id=OTRO", "solo", nil)
			expect(t, status, body, http.StatusForbidden, outOfScope)
		})
	}
}
