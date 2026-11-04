package app_test

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/app"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/identity/infrastructure"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/database"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/database/dbtest"
	tenancyhttp "github.com/Dreamcoder08/sipges/apps/api-go/internal/tenancy/http"
)

// Ported from apps/api/test/identity/auth-http.test.ts, apps/api/test/tenancy/tenancy-http.test.ts
// (scope resolution middleware) and the cross-tenant checks of
// apps/api/test/integration/tenancy-postgres.test.ts, against a migrated synthetic PostgreSQL.
// Every account, project and token here is synthetic.

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

// t0 is the synthetic "now" of every request; sessions expire 8 h after it.
var t0 = time.Date(2026, 11, 3, 12, 0, 0, 0, time.UTC)

const sessionTTL = 8 * time.Hour

// tokens maps a synthetic account to its session token, created at seed time.
var tokens = map[string]string{}

func newToken() string {
	var b [32]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
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
		  ('multi',   'Multi Admin',  'x', 'admin',       true,  true),
		  ('solo',    'Solo Analyst', 'x', 'analista',    true,  true),
		  ('nogrant', 'No Grants',    'x', 'analista',    true,  true),
		  ('reader',  'Read Only',    'x', 'consulta',    true,  true),
		  ('coord',   'Coordinator',  'x', 'coordinador', true,  true),
		  ('nomfa',   'No MFA',       'x', 'analista',    true,  false),
		  ('google',  'Google User',  'x', 'analista',    true,  false),
		  ('gone',    'Inactive',     'x', 'admin',       false, true);
		INSERT INTO grants (username, tenant_id) VALUES
		  ('multi','SIPGES/PRJ-SECHURA'), ('multi','ACME/NORTE'),
		  ('solo','SIPGES/PRJ-SECHURA'), ('reader','ACME/NORTE'), ('coord','ACME/NORTE'),
		  ('nomfa','ACME/NORTE'), ('google','ACME/NORTE'), ('gone','ACME/NORTE');
		INSERT INTO module_records (tenant_id, module, id, payload, created_at, updated_at, marking) VALUES
		  ('SIPGES/PRJ-SECHURA','Eventos','south','{}', now(), now(), 'interno'),
		  ('ACME/NORTE','Eventos','north','{}', now(), now(), 'interno'),
		  ('ACME/NORTE','Eventos','north-secret','{}', now(), now(), 'restringido');`); err != nil {
		return err
	}
	batch := &pgx.Batch{}
	for _, user := range []string{"multi", "solo", "nogrant", "reader", "coord", "nomfa", "google", "gone"} {
		tokens[user] = newToken()
		batch.Queue(`INSERT INTO sessions (token_hash, username, expires_at, via_google) VALUES ($1, $2, $3, $4)`,
			infrastructure.HashToken(tokens[user]), user, t0.Add(sessionTTL), user == "google")
	}
	tokens["expired"] = newToken()
	batch.Queue(`INSERT INTO sessions (token_hash, username, expires_at) VALUES ($1, 'solo', $2)`,
		infrastructure.HashToken(tokens["expired"]), t0.Add(-2*time.Hour))
	return conn.SendBatch(ctx, batch).Close()
}

type clock struct {
	mu sync.Mutex
	at time.Time
}

func (c *clock) now() time.Time { c.mu.Lock(); defer c.mu.Unlock(); return c.at }
func (c *clock) set(at time.Time) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.at = at
}

type server struct {
	url   string
	addr  string
	clock *clock
}

type recordsBody struct {
	IDs       []string `json:"ids"`
	Actor     string   `json:"actor"`
	Clearance string   `json:"clearance"`
}

// start serves the composed API plus GET /test/records, which lists module_records through
// WithRequestTenant: the way every phase 1 route will read tenant data.
func start(t *testing.T, requireMFA bool) *server {
	t.Helper()
	if scratch == nil {
		t.Skip(dbtest.EnvAdminURL + " is not set")
	}
	pool, err := pgxpool.New(t.Context(), scratch.URL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	clk := &clock{at: t0.Add(-time.Hour)}
	h, err := app.NewHandler(pool, app.Options{
		Logger:     slog.New(slog.DiscardHandler),
		RequireMFA: requireMFA,
		Now:        clk.now,
		Routes: func(mux *http.ServeMux) {
			mux.HandleFunc("GET /test/records", func(w http.ResponseWriter, r *http.Request) {
				body, err := tenancyhttp.WithRequestTenant(r, pool, func(ctx context.Context, q database.Querier) (recordsBody, error) {
					var out recordsBody
					rows, err := q.Query(ctx, `SELECT id FROM module_records ORDER BY id`)
					if err != nil {
						return out, err
					}
					if out.IDs, err = pgx.CollectRows(rows, pgx.RowTo[string]); err != nil {
						return out, err
					}
					err = q.QueryRow(ctx, `SELECT current_setting('app.actor'), current_setting('app.clearance')`).Scan(&out.Actor, &out.Clearance)
					return out, err
				})
				if err != nil {
					http.Error(w, err.Error(), http.StatusInternalServerError)
					return
				}
				w.Header().Set("Content-Type", "application/json")
				_ = json.NewEncoder(w).Encode(body)
			})
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	return &server{url: srv.URL, addr: srv.Listener.Addr().String(), clock: clk}
}

type reply struct {
	status int
	body   string
}

type req struct {
	method, path string
	user         string // session of this synthetic account
	headers      map[string]string
	body         string
	sameOrigin   bool
}

func (s *server) do(t *testing.T, q req) reply {
	t.Helper()
	method := q.method
	if method == "" {
		method = http.MethodGet
	}
	r, err := http.NewRequestWithContext(t.Context(), method, s.url+q.path, strings.NewReader(q.body))
	if err != nil {
		t.Fatal(err)
	}
	if q.user != "" {
		r.Header.Set("Cookie", "sipges_session="+tokens[q.user])
	}
	if q.sameOrigin {
		r.Header.Set("Origin", s.url)
	}
	for k, v := range q.headers {
		r.Header.Set(k, v)
	}
	res, err := http.DefaultClient.Do(r)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = res.Body.Close() }()
	b, _ := io.ReadAll(res.Body)
	return reply{res.StatusCode, string(b)}
}

// raw sends the request target byte for byte (an HTTP client would normalize it).
func (s *server) raw(t *testing.T, target, user string) reply {
	t.Helper()
	conn, err := net.Dial("tcp", s.addr)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = conn.Close() }()
	_, _ = fmt.Fprintf(conn, "GET %s HTTP/1.1\r\nHost: %s\r\nCookie: sipges_session=%s\r\nConnection: close\r\n\r\n", target, s.addr, tokens[user])
	res, err := http.ReadResponse(bufio.NewReader(conn), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = res.Body.Close() }()
	b, _ := io.ReadAll(res.Body)
	return reply{res.StatusCode, string(b)}
}

func expect(t *testing.T, got reply, status int, body string) {
	t.Helper()
	if got.status != status || strings.TrimSpace(got.body) != body {
		t.Fatalf("got %d %s\nwant %d %s", got.status, got.body, status, body)
	}
}

const (
	signIn       = `{"detail":"Inicie sesión para acceder a SIPGES"}`
	badOrigin    = `{"detail":"Origen de solicitud no permitido"}`
	notFound     = `{"detail":"Not Found"}`
	otherProject = `{"detail":"No se permite escribir en otro proyecto"}`
	chooseAll    = `{"detail":"Seleccione un proyecto autorizado mediante X-SIPGES-Scope o /select-project","projects":["ACME/NORTE","SIPGES/PRJ-SECHURA"]}`
	sechura      = `{"company_id":"SIPGES","project_id":"PRJ-SECHURA","scope":"SIPGES/PRJ-SECHURA"}`
	norte        = `{"company_id":"ACME","project_id":"NORTE","scope":"ACME/NORTE"}`
)

func TestRejectsRequestsWithoutAValidSession(t *testing.T) {
	s := start(t, false)
	for name, q := range map[string]req{
		"no cookie":                 {path: "/system/auth/current-scope"},
		"unknown path, no cookie":   {path: "/no-such-route"},
		"malformed token":           {path: "/system/auth/current-scope", headers: map[string]string{"Cookie": "sipges_session=not-hex"}},
		"upper-case token":          {path: "/system/auth/current-scope", headers: map[string]string{"Cookie": "sipges_session=" + strings.ToUpper(tokens["solo"])}},
		"unknown token":             {path: "/system/auth/current-scope", headers: map[string]string{"Cookie": "sipges_session=" + newToken()}},
		"token hash as the token":   {path: "/system/auth/current-scope", headers: map[string]string{"Cookie": "sipges_session=" + infrastructure.HashToken(tokens["solo"])}},
		"inactive account":          {path: "/system/auth/current-scope", user: "gone"},
		"expired session":           {path: "/system/auth/current-scope", user: "expired"},
		"write without a session":   {method: "POST", path: "/api/eventos", sameOrigin: true},
		"session in another cookie": {path: "/system/auth/current-scope", headers: map[string]string{"Cookie": "sipges_scope=" + tokens["solo"]}},
	} {
		t.Run(name, func(t *testing.T) { expect(t, s.do(t, q), http.StatusUnauthorized, signIn) })
	}
}

func TestExpiresSessionsAtExactlyTheirExpiry(t *testing.T) {
	s := start(t, false)
	s.clock.set(t0.Add(sessionTTL - time.Millisecond))
	expect(t, s.do(t, req{path: "/system/auth/current-scope", user: "solo"}), http.StatusOK, sechura)
	s.clock.set(t0.Add(sessionTTL))
	expect(t, s.do(t, req{path: "/system/auth/current-scope", user: "solo"}), http.StatusUnauthorized, signIn)
}

func TestPublicAndMachinePathsNeedNoSession(t *testing.T) {
	s := start(t, true)
	if got := s.do(t, req{path: "/health"}); got.status != http.StatusOK {
		t.Fatalf("/health: %d", got.status)
	}
	// Public writes still need the Origin check; the Go API does not serve /login yet.
	expect(t, s.do(t, req{method: "POST", path: "/login"}), http.StatusForbidden, badOrigin)
	expect(t, s.do(t, req{method: "POST", path: "/login", sameOrigin: true}), http.StatusNotFound, notFound)
	// Machine paths authenticate with their own credential in their route (none served yet).
	expect(t, s.do(t, req{method: "POST", path: "/mcp"}), http.StatusNotFound, notFound)
	expect(t, s.do(t, req{method: "POST", path: "/hooks/feed"}), http.StatusNotFound, notFound)
}

func TestChecksTheOriginOfWrites(t *testing.T) {
	s := start(t, false)
	expect(t, s.do(t, req{method: "POST", path: "/api/eventos", user: "solo"}), http.StatusForbidden, badOrigin)
	expect(t, s.do(t, req{method: "POST", path: "/api/eventos", user: "solo",
		headers: map[string]string{"Origin": "https://evil.example"}}), http.StatusForbidden, badOrigin)
	expect(t, s.do(t, req{method: "DELETE", path: unserved, user: "solo",
		headers: map[string]string{"Referer": s.url + "/page"}}), http.StatusNotFound, notFound)
}

func TestRequiresMFAEnrolmentWhenConfigured(t *testing.T) {
	s := start(t, true)
	expect(t, s.do(t, req{path: "/system/auth/current-scope", user: "nomfa"}), http.StatusForbidden,
		`{"detail":"Active la verificación en dos pasos (MFA) con /system/auth/totp/setup antes de continuar","mfa_required":true}`)
	// Enrolment paths stay open and scope-free (served by TypeScript, so 404 here).
	expect(t, s.do(t, req{method: "POST", path: "/system/auth/totp/setup", user: "nomfa", sameOrigin: true}), http.StatusNotFound, notFound)
	// Google sign-in stands in for TOTP (ADR 0010); TOTP-enabled accounts pass.
	expect(t, s.do(t, req{path: "/system/auth/current-scope", user: "google"}), http.StatusOK, norte)
	expect(t, s.do(t, req{path: "/system/auth/current-scope", user: "solo"}), http.StatusOK, sechura)
	// Without SIPGES_REQUIRE_MFA the same session passes.
	expect(t, start(t, false).do(t, req{path: "/system/auth/current-scope", user: "nomfa"}), http.StatusOK, norte)
}

func TestResolvesTheProjectScope(t *testing.T) {
	s := start(t, false)
	t.Run("sole grant when nothing was requested", func(t *testing.T) {
		expect(t, s.do(t, req{path: "/system/auth/current-scope", user: "solo"}), http.StatusOK, sechura)
	})
	t.Run("several grants: choose, listed in order", func(t *testing.T) {
		expect(t, s.do(t, req{path: "/system/auth/current-scope", user: "multi"}), http.StatusForbidden, chooseAll)
	})
	t.Run("X-SIPGES-Scope is honoured", func(t *testing.T) {
		expect(t, s.do(t, req{path: "/system/auth/current-scope", user: "multi",
			headers: map[string]string{"X-SIPGES-Scope": "ACME/NORTE"}}), http.StatusOK, norte)
	})
	t.Run("the scope cookie is honoured, URI-decoded", func(t *testing.T) {
		expect(t, s.do(t, req{path: "/system/auth/current-scope", headers: map[string]string{
			"Cookie": "sipges_session=" + tokens["multi"] + "; sipges_scope=SIPGES%2FPRJ-SECHURA"}}), http.StatusOK, sechura)
	})
	t.Run("a project without a grant is refused", func(t *testing.T) {
		for _, scope := range []string{"EVIL/CORP", "ACME/NORTE"} {
			expect(t, s.do(t, req{path: "/system/auth/current-scope", user: "solo",
				headers: map[string]string{"X-SIPGES-Scope": scope}}), http.StatusForbidden,
				`{"detail":"Seleccione un proyecto autorizado mediante X-SIPGES-Scope o /select-project","projects":["SIPGES/PRJ-SECHURA"]}`)
		}
	})
	t.Run("a user without grants is denied every scoped route", func(t *testing.T) {
		expect(t, s.do(t, req{method: "POST", path: "/api/eventos", user: "nogrant", sameOrigin: true,
			headers: map[string]string{"Content-Type": "application/json"}, body: `{"payload":{"Descripcion_Hecho":"x"}}`}),
			http.StatusForbidden, `{"detail":"Seleccione un proyecto autorizado mediante X-SIPGES-Scope o /select-project","projects":[]}`)
	})
	t.Run("a query project_id outside the scope is refused", func(t *testing.T) {
		expect(t, s.do(t, req{path: "/system/auth/current-scope?project_id=NORTE", user: "solo"}),
			http.StatusForbidden, `{"detail":"Proyecto fuera de alcance"}`)
		expect(t, s.do(t, req{path: "/system/auth/current-scope?project_id=PRJ%2DSECHURA", user: "solo"}), http.StatusOK, sechura)
		expect(t, s.do(t, req{path: "/system/auth/current-scope?project_id=%ZZ", user: "solo"}),
			http.StatusForbidden, `{"detail":"Proyecto fuera de alcance"}`)
	})
}

// unserved is a write path under /api/ that the gates check and no route serves, so a request
// the gates let through answers the router's 404 (the records writes now serve /api/eventos).
const unserved = "/api/eventos/1/unserved"

func TestRefusesJSONBodiesThatNameAnotherProject(t *testing.T) {
	s := start(t, false)
	post := func(body string, contentType string) reply {
		return s.do(t, req{method: "POST", path: unserved, user: "solo", sameOrigin: true,
			headers: map[string]string{"Content-Type": contentType}, body: body})
	}
	for _, body := range []string{
		`{"project_id":"NORTE","payload":{}}`,
		`{"payload":{"Proyecto_ID":"NORTE"}}`,
		`{"payload":{"project_id":"NORTE"}}`,
		`{"project_id":7}`,
		`{"project_id":1e400}`,
		`{"project_id":true}`,
		`{"project_id":["PRJ-SECHURA"]}`,
		`{"project_id":"","payload":{"Proyecto_ID":"NORTE"}}`,
		"\xef\xbb\xbf{\"project_id\":\"NORTE\"}",            // Response.text() drops the byte order mark
		`{"project_id":"PRJ-SECHURA","project_id":"NORTE"}`, // the last duplicate wins
	} {
		t.Run(body, func(t *testing.T) {
			expect(t, post(body, "application/json"), http.StatusForbidden, otherProject)
			expect(t, post(body, "application/json; charset=utf-8"), http.StatusForbidden, otherProject)
		})
	}
	for _, body := range []string{
		`{"project_id":"PRJ-SECHURA","payload":{"Descripcion_Hecho":"x"}}`,
		`{"project_id":0,"payload":{"Proyecto_ID":""}}`,
		`{"project_id":1e-400}`,
		`{"payload":["NORTE"]}`,
		`["NORTE"]`,
		`{"project_id":"NORTE"} trailing`, // JSON.parse throws: read as {}
		`not json`,
	} {
		t.Run("passes "+body, func(t *testing.T) { expect(t, post(body, "application/json"), http.StatusNotFound, notFound) })
	}
	t.Run("a body nested beyond Go's decoder is refused, not read as {}", func(t *testing.T) {
		deep := `{"project_id":"NORTE","x":` + strings.Repeat("[", 10001) + strings.Repeat("]", 10001) + `}`
		expect(t, post(deep, "application/json"), http.StatusForbidden, otherProject)
	})
	t.Run("other content types are not inspected", func(t *testing.T) {
		expect(t, post(`{"project_id":"NORTE"}`, "text/plain"), http.StatusNotFound, notFound)
		expect(t, post(`{"project_id":"NORTE"}`, "Application/JSON"), http.StatusNotFound, notFound)
	})
	t.Run("only under /api/ and /system/", func(t *testing.T) {
		got := s.do(t, req{method: "POST", path: "/other", user: "solo", sameOrigin: true,
			headers: map[string]string{"Content-Type": "application/json"}, body: `{"project_id":"NORTE"}`})
		expect(t, got, http.StatusNotFound, notFound)
	})
}

func TestAppliesTheRoleGateAfterTheScope(t *testing.T) {
	s := start(t, false)
	expect(t, s.do(t, req{method: "POST", path: "/api/eventos", user: "reader", sameOrigin: true}),
		http.StatusForbidden, `{"detail":"Rol de consulta: solo lectura"}`)
	expect(t, s.do(t, req{method: "POST", path: "/api/eventos", user: "coord", sameOrigin: true}),
		http.StatusForbidden, `{"detail":"Operación restringida para coordinador"}`)
	expect(t, s.do(t, req{path: "/system/audit", user: "solo"}), http.StatusForbidden, `{"detail":"Requiere rol administrador"}`)
	// The scope is resolved first: a user without grants gets the scope 403, not the role one.
	if got := s.do(t, req{path: "/system/audit", user: "nogrant"}); !strings.Contains(got.body, "Seleccione un proyecto") {
		t.Fatalf("got %d %s", got.status, got.body)
	}
}

// The gates and the router read one canonical path, so an escaped spelling can neither skip a
// gate nor reach a route the plain spelling would not.
func TestGatesAndRoutingReadTheSameCanonicalPath(t *testing.T) {
	s := start(t, false)
	expect(t, s.raw(t, "/system/auth/%63urrent-scope", "solo"), http.StatusOK, sechura)
	expect(t, s.raw(t, "/system/%61udit", "solo"), http.StatusForbidden, `{"detail":"Requiere rol administrador"}`)
	expect(t, s.raw(t, "/x/../system/audit", "solo"), http.StatusForbidden, `{"detail":"Requiere rol administrador"}`)
	expect(t, s.raw(t, "/heal%74h/../system/audit", "solo"), http.StatusForbidden, `{"detail":"Requiere rol administrador"}`)
	got := s.raw(t, "/heal%74h", "")
	if got.status != http.StatusOK {
		t.Fatalf("/heal%%74h is /health in Hono too: %d %s", got.status, got.body)
	}
	expect(t, s.raw(t, "/health%2Fready", ""), http.StatusUnauthorized, signIn)
}

func TestTenantWorkSeesOnlyTheResolvedProject(t *testing.T) {
	s := start(t, false)
	records := func(user string, headers map[string]string) recordsBody {
		t.Helper()
		got := s.do(t, req{path: "/test/records", user: user, headers: headers})
		if got.status != http.StatusOK {
			t.Fatalf("%s: %d %s", user, got.status, got.body)
		}
		var b recordsBody
		if err := json.Unmarshal([]byte(got.body), &b); err != nil {
			t.Fatal(err)
		}
		return b
	}
	for scope, want := range map[string][]string{
		"ACME/NORTE":         {"north", "north-secret"},
		"SIPGES/PRJ-SECHURA": {"south"},
	} {
		got := records("multi", map[string]string{"X-SIPGES-Scope": scope})
		if !slices.Equal(got.IDs, want) || got.Actor != "multi" || got.Clearance != "full" {
			t.Fatalf("%s: %+v, want ids %v as multi/full", scope, got, want)
		}
	}
	// A read-only account has limited clearance: restricted records stay invisible (ADR 0012).
	if got := records("reader", nil); !slices.Equal(got.IDs, []string{"north"}) || got.Actor != "reader" || got.Clearance != "limited" {
		t.Fatalf("reader: %+v", got)
	}
	// Asking for a project without a grant never reaches tenant work.
	if got := s.do(t, req{path: "/test/records", user: "solo", headers: map[string]string{"X-SIPGES-Scope": "ACME/NORTE"}}); got.status != http.StatusForbidden {
		t.Fatalf("cross-tenant request: %d %s", got.status, got.body)
	}
}

func TestWithRequestTenantRefusesARequestWithoutAScope(t *testing.T) {
	r := httptest.NewRequest(http.MethodGet, "/x", nil)
	_, err := tenancyhttp.WithRequestTenant(r, nil, func(context.Context, database.Querier) (int, error) {
		t.Fatal("work ran without a scope")
		return 0, nil
	})
	if !errors.Is(err, tenancyhttp.ErrNoScope) {
		t.Fatalf("err = %v", err)
	}
}
