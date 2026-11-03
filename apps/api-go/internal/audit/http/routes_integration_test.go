package http_test

import (
	"bufio"
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

// Ported from the audit checks of apps/api/test (GET /system/audit and the live activity
// stream of apps/api/test/platform/realtime-trace.test.ts), against a migrated synthetic
// PostgreSQL through the composed handler, so the session, scope and role gates run as in
// production. Every account, project and entry here is synthetic.

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

var t0 = time.Date(2026, 11, 3, 12, 0, 0, 0, time.UTC)

var tokens = map[string]string{}

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
		  ('boss',   'South Admin',  'x', 'admin',    true, true),
		  ('solo',   'Solo Analyst', 'x', 'analista', true, true),
		  ('reader', 'Read Only',    'x', 'consulta', true, true);
		INSERT INTO grants (username, tenant_id) VALUES
		  ('multi','SIPGES/PRJ-SECHURA'), ('multi','ACME/NORTE'), ('boss','SIPGES/PRJ-SECHURA'),
		  ('solo','SIPGES/PRJ-SECHURA'), ('reader','SIPGES/PRJ-SECHURA');
		INSERT INTO audit (tenant_id, ts, module, record_id, action, detail) VALUES
		  ('SIPGES/PRJ-SECHURA', '2026-01-02 03:04:05.678+00', 'Riesgos', 'D-1', 'CREATE', 'Alta sintética'),
		  ('ACME/NORTE',         '2026-01-02 03:04:06+00',     'Eventos',  'N-1', 'CREATE', 'Fila ajena'),
		  ('SIPGES/PRJ-SECHURA', '2026-01-03 10:00:00-05',     'Eventos',  NULL,  'UPDATE', NULL),
		  ('SIPGES/PRJ-SECHURA', '2026-01-04 00:00:00+00',     'SIPGES',   'S-1', 'LOGIN',  'a <b> & "c"');`); err != nil {
		return err
	}
	batch := &pgx.Batch{}
	for _, user := range []string{"multi", "boss", "solo", "reader"} {
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
	h := app.NewHandler(pool, app.Options{Logger: slog.New(slog.DiscardHandler), Now: func() time.Time { return t0 }})
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
	return res.StatusCode, strings.TrimSuffix(string(b), "\n")
}

func expect(t *testing.T, gotStatus int, gotBody string, status int, body string) {
	t.Helper()
	if gotStatus != status || gotBody != body {
		t.Errorf("got %d %s\nwant %d %s", gotStatus, gotBody, status, body)
	}
}

const (
	southLogin  = `{"id":4,"ts":"2026-01-04T00:00:00Z","module":"SIPGES","record_id":"S-1","action":"LOGIN","detail":"a <b> & \"c\""}`
	southUpdate = `{"id":3,"ts":"2026-01-03T15:00:00Z","module":"Eventos","record_id":null,"action":"UPDATE","detail":null}`
	southCreate = `{"id":1,"ts":"2026-01-02T03:04:05Z","module":"Riesgos","record_id":"D-1","action":"CREATE","detail":"Alta sintética"}`
	northCreate = `{"id":2,"ts":"2026-01-02T03:04:06Z","module":"Eventos","record_id":"N-1","action":"CREATE","detail":"Fila ajena"}`
	intParsing  = `{"detail":[{"type":"int_parsing","loc":["query","limit"],"msg":"Input should be a valid integer, unable to parse string as an integer"}]}`
)

func TestListsTheProjectTrailNewestFirst(t *testing.T) {
	base := start(t)
	all := "[" + southLogin + "," + southUpdate + "," + southCreate + "]"
	status, body := get(t, base, "/system/audit", "boss", nil)
	expect(t, status, body, http.StatusOK, all)
	for path, want := range map[string]string{
		"/system/audit?limit=2":       "[" + southLogin + "," + southUpdate + "]",
		"/system/audit?limit=0":       "[]",
		"/system/audit?limit=-1":      all, // negative reads the ceiling
		"/system/audit?limit=501":     all,
		"/system/audit?limit=%201%20": "[" + southLogin + "]",
	} {
		status, body := get(t, base, path, "boss", nil)
		expect(t, status, body, http.StatusOK, want)
	}
}

func TestRefusesALimitThatIsNotAnInteger(t *testing.T) {
	base := start(t)
	for _, path := range []string{"/system/audit?limit=abc", "/system/audit?limit=", "/system/audit?limit=2.5"} {
		status, body := get(t, base, path, "boss", nil)
		expect(t, status, body, http.StatusUnprocessableEntity, intParsing)
	}
}

func TestAuditIsAdminOnlyAndScoped(t *testing.T) {
	base := start(t)
	status, body := get(t, base, "/system/audit", "", nil)
	expect(t, status, body, http.StatusUnauthorized, `{"detail":"Inicie sesión para acceder a SIPGES"}`)
	for _, user := range []string{"solo", "reader"} {
		status, body := get(t, base, "/system/audit", user, nil)
		expect(t, status, body, http.StatusForbidden, `{"detail":"Requiere rol administrador"}`)
	}
	// An administrator without a grant on the named project gets the scope 403.
	status, body = get(t, base, "/system/audit", "boss", map[string]string{"X-SIPGES-Scope": "ACME/NORTE"})
	expect(t, status, body, http.StatusForbidden,
		`{"detail":"Seleccione un proyecto autorizado mediante X-SIPGES-Scope o /select-project","projects":["SIPGES/PRJ-SECHURA"]}`)
}

func TestAuditNeverReturnsAnotherProjectsRows(t *testing.T) {
	base := start(t)
	status, body := get(t, base, "/system/audit", "multi", map[string]string{"X-SIPGES-Scope": "ACME/NORTE"})
	expect(t, status, body, http.StatusOK, "["+northCreate+"]")
	status, body = get(t, base, "/system/audit", "multi", map[string]string{"X-SIPGES-Scope": "SIPGES/PRJ-SECHURA"})
	expect(t, status, body, http.StatusOK, "["+southLogin+","+southUpdate+","+southCreate+"]")
	if strings.Contains(body, "Fila ajena") {
		t.Error("the trail leaked another project's row")
	}
}

// events reads the activity stream until it has n events or the deadline passes.
func events(t *testing.T, base, user string, headers map[string]string, n int) (int, []string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	r, err := http.NewRequestWithContext(ctx, http.MethodGet, base+"/system/events", nil)
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
	if res.StatusCode != http.StatusOK {
		return res.StatusCode, nil
	}
	var out []string
	var current strings.Builder
	sc := bufio.NewScanner(res.Body)
	for len(out) < n && sc.Scan() {
		if sc.Text() == "" {
			out = append(out, current.String())
			current.Reset()
			continue
		}
		current.WriteString(sc.Text() + "|")
	}
	return res.StatusCode, out
}

func TestActivityStreamThroughTheGates(t *testing.T) {
	base := start(t)
	if status, _ := events(t, base, "", nil, 1); status != http.StatusUnauthorized {
		t.Fatalf("without a session: %d", status)
	}
	// Every role may listen; the first poll runs right after `ready`, so a resume from 0
	// replays the project's trail at once, without another project's entries.
	status, got := events(t, base, "reader", map[string]string{"Last-Event-ID": "0"}, 4)
	want := []string{
		"event: ready|data: {}|id: 0|",
		`event: activity|data: {"module":"Riesgos","action":"CREATE"}|id: 1|`,
		`event: activity|data: {"module":"Eventos","action":"UPDATE"}|id: 3|`,
		`event: activity|data: {"module":"SIPGES","action":"LOGIN"}|id: 4|`,
	}
	if status != http.StatusOK || strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Fatalf("got %d\n%s\nwant\n%s", status, strings.Join(got, "\n"), strings.Join(want, "\n"))
	}
	// Without Last-Event-ID the stream starts at the project's newest entry.
	_, got = events(t, base, "multi", map[string]string{"X-SIPGES-Scope": "ACME/NORTE"}, 1)
	if len(got) != 1 || got[0] != "event: ready|data: {}|id: 2|" {
		t.Fatalf("ready of ACME/NORTE: %q", got)
	}
}
