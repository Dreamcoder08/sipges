//nolint:misspell // Spanish record fields and modules, verbatim from the TypeScript API.
package http_test

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/app"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/identity/infrastructure"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/database/dbtest"
)

// The situations read routes against a migrated synthetic PostgreSQL, through the composed
// handler (session, project scope, role gate). Every account, project and record is synthetic.
// The JSON itself is checked against the TypeScript routes by ../application/fixtures_test.go
// and the parity runner; these tests pin tenant isolation, the clearance and the gates.

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

// t0 is the synthetic "now": 2026-11-03 in Lima.
var t0 = time.Date(2026, 11, 3, 15, 0, 0, 0, time.UTC)

var tokens = map[string]string{}

// tenantRows inserts one tenant's rows inside a transaction entered as that tenant with full
// clearance, so the row-level security policies hold even for a non-superuser test login.
func tenantRows(ctx context.Context, conn *pgx.Conn, tenant, sql string) error {
	tx, err := conn.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true), set_config('app.clearance', 'full', true)`, tenant); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, sql); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func record(tenant, module, id, marking, payload string) string {
	return fmt.Sprintf(`INSERT INTO module_records (tenant_id, module, id, payload, created_at, updated_at, marking)
		VALUES ('%s', '%s', '%s', '%s', '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z', '%s');`,
		tenant, module, id, payload, marking)
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
	sechura := "SIPGES/PRJ-SECHURA"
	rows := record(sechura, "Eventos", "EV-1", "interno", `{"Fecha":"2026-11-01","Tema":"Agua","Descripcion_Hecho":"Corte de agua"}`) +
		record(sechura, "Demandas", "D-1", "interno", `{"Fecha":"2026-10-30","Tema":"Agua","Descripcion":"Pozo seco"}`) +
		// Only full clearance sees it: a read-only account gets a situation of two records.
		record(sechura, "Alertas", "AL-1", "restringido", `{"Fecha":"2026-11-02","Tema":"Agua","Causa":"Reservado"}`) +
		record(sechura, "Lecciones_Territoriales", "LEC-1", "interno", `{"Fecha":"2025-01-01","Tema":"Agua","Aprendido":"Avisar antes"}`) +
		`INSERT INTO project_settings (tenant_id, settings, updated_by, updated_at) VALUES
		  ('SIPGES/PRJ-SECHURA', '{"windowDays": 60, "halfLifeDays": 10, "phase": "operacion"}', 'multi',
		   '2026-10-01T12:00:00.123456Z');`
	if err := tenantRows(ctx, conn, sechura, rows); err != nil {
		return fmt.Errorf("sechura: %w", err)
	}
	// Another tenant reuses the ids: only RLS keeps its records and settings out of Sechura.
	norte := "ACME/NORTE"
	rows = record(norte, "Eventos", "EV-1", "interno", `{"Fecha":"2026-11-01","Tema":"Salud","Descripcion_Hecho":"Norte secreto"}`) +
		record(norte, "Demandas", "D-1", "interno", `{"Fecha":"2026-10-30","Tema":"Salud","Descripcion":"Norte secreto"}`) +
		`INSERT INTO project_settings (tenant_id, settings, updated_by, updated_at) VALUES
		  ('ACME/NORTE', '{"windowDays": 30}', 'norte', '2026-09-09T09:09:09Z');`
	if err := tenantRows(ctx, conn, norte, rows); err != nil {
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

type situationsBody struct {
	GeneratedAt string `json:"generated_at"`
	Today       string `json:"today"`
	WindowDays  int    `json:"window_days"`
	Considered  int    `json:"considered"`
	Situations  []struct {
		Key     string `json:"key"`
		Records []struct {
			Module string `json:"module"`
			ID     string `json:"id"`
			Title  string `json:"title"`
		} `json:"records"`
		Lessons []struct {
			ID string `json:"id"`
		} `json:"lessons"`
	} `json:"situations"`
}

func situations(t *testing.T, base, user string, headers map[string]string) situationsBody {
	t.Helper()
	status, body := get(t, base, "/system/v4/situations", user, headers)
	if status != http.StatusOK {
		t.Fatalf("status %d: %s", status, body)
	}
	var out situationsBody
	if err := json.Unmarshal([]byte(body), &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func cited(b situationsBody) []string {
	var out []string
	for _, s := range b.Situations {
		for _, r := range s.Records {
			out = append(out, s.Key+" "+r.Module+":"+r.ID+" "+r.Title)
		}
	}
	return out
}

func TestSituationsReadTheResolvedTenantOnly(t *testing.T) {
	base := start(t)
	full := []string{
		"tema:agua Alertas:AL-1 Reservado",
		"tema:agua Eventos:EV-1 Corte de agua",
		"tema:agua Demandas:D-1 Agua", // a demand is titled by its topic
	}
	got := situations(t, base, "solo", nil)
	if got.GeneratedAt != "2026-11-03T15:00:00.000Z" || got.Today != "2026-11-03" || got.WindowDays != 60 || got.Considered != 3 {
		t.Fatalf("header: %+v", got)
	}
	if c := cited(got); !slices.Equal(c, full) {
		t.Fatalf("analyst sees %v, want %v", c, full)
	}
	if len(got.Situations[0].Lessons) != 1 || got.Situations[0].Lessons[0].ID != "LEC-1" {
		t.Fatalf("lessons: %+v", got.Situations[0].Lessons)
	}
	// The read-only role never sees the record marked 'restringido' (ADR 0012).
	if c := cited(situations(t, base, "reader", nil)); !slices.Equal(c, full[1:]) {
		t.Fatalf("read-only account sees %v", c)
	}
	// The same ids in another tenant: each scope reads its own records only.
	if c := cited(situations(t, base, "multi", map[string]string{"X-SIPGES-Scope": "SIPGES/PRJ-SECHURA"})); !slices.Equal(c, full) {
		t.Fatalf("multi on Sechura sees %v", c)
	}
	norte := situations(t, base, "multi", map[string]string{"X-SIPGES-Scope": "ACME/NORTE"})
	want := []string{"tema:salud Eventos:EV-1 Norte secreto", "tema:salud Demandas:D-1 Salud"}
	if c := cited(norte); !slices.Equal(c, want) || norte.WindowDays != 30 {
		t.Fatalf("multi on Norte sees %v (window %d)", c, norte.WindowDays)
	}
}

func TestSettingsReadTheResolvedTenantOnly(t *testing.T) {
	base := start(t)
	read := func(user string, headers map[string]string) map[string]any {
		status, body := get(t, base, "/system/v4/settings", user, headers)
		if status != http.StatusOK {
			t.Fatalf("status %d: %s", status, body)
		}
		var out map[string]any
		if err := json.Unmarshal([]byte(body), &out); err != nil {
			t.Fatal(err)
		}
		return out
	}
	s := read("reader", nil)
	if s["window_days"] != 60.0 || s["half_life_days"] != 10.0 || s["phase"] != "operacion" ||
		s["updated_by"] != "multi" || s["updated_at"] != "2026-10-01T12:00:00.123Z" {
		t.Fatalf("Sechura settings: %v", s)
	}
	n := read("multi", map[string]string{"X-SIPGES-Scope": "ACME/NORTE"})
	if n["window_days"] != 30.0 || n["half_life_days"] != 14.0 || n["phase"] != nil || n["updated_by"] != "norte" {
		t.Fatalf("Norte settings: %v", n)
	}
}

func TestRefusesRequestsOutsideTheScope(t *testing.T) {
	base := start(t)
	const (
		signIn     = `{"detail":"Inicie sesión para acceder a SIPGES"}`
		outOfScope = `{"detail":"Proyecto fuera de alcance"}`
		choose     = `{"detail":"Seleccione un proyecto autorizado mediante X-SIPGES-Scope o /select-project","projects":["ACME/NORTE","SIPGES/PRJ-SECHURA"]}`
		chooseSolo = `{"detail":"Seleccione un proyecto autorizado mediante X-SIPGES-Scope o /select-project","projects":["SIPGES/PRJ-SECHURA"]}`
		notFound   = `{"detail":"Not Found"}`
	)
	for _, path := range []string{"/system/v4/settings", "/system/v4/situations"} {
		t.Run(path, func(t *testing.T) {
			for _, c := range []struct {
				user    string
				headers map[string]string
				suffix  string
				status  int
				body    string
			}{
				{"", nil, "", http.StatusUnauthorized, signIn},
				{"solo", map[string]string{"X-SIPGES-Scope": "ACME/NORTE"}, "", http.StatusForbidden, chooseSolo},
				{"solo", nil, "?project_id=NORTE", http.StatusForbidden, outOfScope},
				{"multi", nil, "", http.StatusForbidden, choose},
				{"solo", nil, "/", http.StatusNotFound, notFound},
			} {
				status, body := get(t, base, path+c.suffix, c.user, c.headers)
				if status != c.status || body != c.body {
					t.Errorf("%s%s as %q: got %d %s, want %d %s", path, c.suffix, c.user, status, body, c.status, c.body)
				}
			}
		})
	}
}
