package app_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/identity/infrastructure"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/tenancy/domain"
	tenancy "github.com/Dreamcoder08/sipges/apps/api-go/internal/tenancy/infrastructure"
)

// Ported from apps/api/test/tenancy/tenancy-http.test.ts, access-lifecycle.test.ts (grants) and
// independent-inputs.test.ts, plus the cross-tenant attempts of the T33 port. Each test creates
// its own synthetic accounts and projects, so the shared seed of app_integration_test.go stays
// as it is.

const (
	scopeForbidden = `{"detail":"Administrador requerido"}`
	grantForbidden = `{"detail":"Forbidden"}`
	okTrue         = `{"ok":true}`
	nulBody        = `{"detail":[{"type":"custom","loc":["body"],"msg":"Text must not contain NUL characters"}]}`
)

// tenancyFixture holds one test's synthetic accounts and projects, all named after prefix.
type tenancyFixture struct {
	s      *server
	prefix string
	conn   *pgx.Conn
}

func newTenancyFixture(t *testing.T, prefix string) *tenancyFixture {
	t.Helper()
	s := start(t, false)
	conn, err := pgx.Connect(t.Context(), scratch.URL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close(context.Background()) })
	return &tenancyFixture{s: s, prefix: prefix, conn: conn}
}

// name is a synthetic account or project id unique to the test.
func (f *tenancyFixture) name(suffix string) string { return f.prefix + "-" + suffix }

// account creates an active account with MFA, a session and the given projects.
func (f *tenancyFixture) account(t *testing.T, suffix, role string, projects ...string) string {
	t.Helper()
	user := f.name(suffix)
	f.exec(t, `INSERT INTO users (username, full_name, password_hash, role, active, totp_enabled) VALUES ($1, 'Synthetic', 'x', $2, true, true)`, user, role)
	tokens[user] = newToken()
	f.exec(t, `INSERT INTO sessions (token_hash, username, expires_at) VALUES ($1, $2, $3)`,
		infrastructure.HashToken(tokens[user]), user, t0.Add(sessionTTL))
	for _, p := range projects {
		f.exec(t, `INSERT INTO grants (username, tenant_id) VALUES ($1, $2)`, user, p)
	}
	return user
}

// project creates a tenant row; it returns "company/project".
func (f *tenancyFixture) project(t *testing.T, company, project string) string {
	t.Helper()
	f.exec(t, `INSERT INTO tenants (company_id, project_id, label) VALUES ($1, $2, 'Synthetic')`, company, project)
	return company + "/" + project
}

func (f *tenancyFixture) exec(t *testing.T, sql string, args ...any) {
	t.Helper()
	if _, err := f.conn.Exec(t.Context(), sql, args...); err != nil {
		t.Fatal(err)
	}
}

// rows is the stored tenants and grants of this test's names, to prove a refusal wrote nothing.
func (f *tenancyFixture) rows(t *testing.T) string {
	t.Helper()
	var out string
	err := f.conn.QueryRow(t.Context(), `SELECT
	  (SELECT coalesce(string_agg(tenant_id || '|' || label || '|' || (created_at AT TIME ZONE 'UTC')::text, ',' ORDER BY tenant_id), '')
	     FROM tenants WHERE company_id LIKE $1 OR project_id LIKE $1) || ' / ' ||
	  (SELECT coalesce(string_agg(username || '>' || tenant_id || '|' || (created_at AT TIME ZONE 'UTC')::text, ',' ORDER BY username, tenant_id), '')
	     FROM grants WHERE username LIKE $1 OR tenant_id LIKE '%' || $1)`, f.prefix+"%").Scan(&out)
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func (f *tenancyFixture) send(t *testing.T, method, path, user, body string) reply {
	t.Helper()
	return f.s.do(t, req{method: method, path: path, user: user, sameOrigin: true,
		headers: map[string]string{"Content-Type": "application/json"}, body: body})
}

func jsonText(v any) string {
	b, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return string(b)
}

func grantJSON(user, scope string) string {
	company, project, _ := strings.Cut(scope, "/")
	return jsonText(struct {
		Username  string `json:"username"`
		CompanyID string `json:"company_id"`
		ProjectID string `json:"project_id"`
	}{user, company, project})
}

func scopeJSON(company, project, label, user string) string {
	return jsonText(struct {
		CompanyID string `json:"company_id"`
		ProjectID string `json:"project_id"`
		Label     string `json:"label"`
		Username  string `json:"username"`
	}{company, project, label, user})
}

func scopesOf(company, project, label string) string {
	return fmt.Sprintf(`{"company_id":%q,"project_id":%q,"label":%q}`, company, project, label)
}

func TestTenancyCreatesProjectsForTheNamedUserOnly(t *testing.T) {
	f := newTenancyFixture(t, "T33C")
	home := f.project(t, "T33C", "HOME")
	admin := f.account(t, "admin", "admin", home)
	ana := f.account(t, "ana", "analista")

	expect(t, f.send(t, "POST", "/system/auth/scopes", admin, scopeJSON("T33C", "NORTE", "Proyecto Norte", ana)),
		http.StatusOK, `{"ok":true,"scope":"T33C/NORTE"}`)
	expect(t, f.s.do(t, req{path: "/system/auth/scopes", user: ana}), http.StatusOK, "["+scopesOf("T33C", "NORTE", "Proyecto Norte")+"]")
	expect(t, f.s.do(t, req{path: "/system/auth/scopes", user: admin}), http.StatusOK, "["+scopesOf("T33C", "HOME", "Synthetic")+"]")
	// The created project resolves for its user at once (the request cache was dropped).
	expect(t, f.s.do(t, req{path: "/system/auth/current-scope", user: ana}), http.StatusOK,
		`{"company_id":"T33C","project_id":"NORTE","scope":"T33C/NORTE"}`)

	// Same rows the TypeScript store writes: the clock's millisecond instant on both.
	var label, created, granted string
	if err := f.conn.QueryRow(t.Context(), `SELECT t.label, (t.created_at AT TIME ZONE 'UTC')::text, (g.created_at AT TIME ZONE 'UTC')::text
	   FROM tenants t JOIN grants g ON g.tenant_id = t.tenant_id WHERE t.tenant_id = 'T33C/NORTE' AND g.username = $1`, ana).
		Scan(&label, &created, &granted); err != nil {
		t.Fatal(err)
	}
	if label != "Proyecto Norte" || created != granted || created != "2026-11-03 11:00:00" {
		t.Fatalf("stored %q %q %q", label, created, granted)
	}
}

func TestTenancyRefusesInvalidCreationWithoutStoringAnything(t *testing.T) {
	f := newTenancyFixture(t, "T33R")
	admin := f.account(t, "admin", "admin", f.project(t, "T33R", "HOME"))
	ana := f.account(t, "ana", "analista")
	f.s.clock.set(t0.Add(-time.Hour + 123456789*time.Nanosecond))
	cases := []struct {
		name, body string
		status     int
		detail     string
	}{
		{"short company", scopeJSON("A", "T33R-N", "x", ana), 422, `{"detail":"IDs inválidos"}`},
		{"space in project", scopeJSON("T33R", "has space", "x", ana), 422, `{"detail":"IDs inválidos"}`},
		{"reserved", scopeJSON("SIPGES", "PRJ-SECHURA", "x", ana), 409, `{"detail":"Proyecto reservado"}`},
		{"user missing", scopeJSON("T33R", "NORTE", "x", "T33R-nobody"), 404, `{"detail":"Usuario no existe"}`},
		{"NUL in label", scopeJSON("T33R", "NORTE", "x\x00", ana), 422, nulBody},
		{"missing field", `{"company_id":"T33R"}`, 422, `{"detail":[{"type":"missing","loc":["body","project_id"],"msg":"Field required"},{"type":"missing","loc":["body","label"],"msg":"Field required"},{"type":"missing","loc":["body","username"],"msg":"Field required"}]}`},
		{"not JSON", `{`, 422, `{"detail":[{"type":"json_invalid","loc":["body"],"msg":"JSON decode error"}]}`},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			before := f.rows(t)
			expect(t, f.send(t, "POST", "/system/auth/scopes", admin, c.body), c.status, c.detail)
			if after := f.rows(t); after != before {
				t.Fatalf("rows changed:\n%s\n%s", before, after)
			}
		})
	}
	t.Run("a duplicate keeps the original label", func(t *testing.T) {
		expect(t, f.send(t, "POST", "/system/auth/scopes", admin, scopeJSON("T33R", "NORTE", "Proyecto Norte", ana)), 200, `{"ok":true,"scope":"T33R/NORTE"}`)
		before := f.rows(t)
		expect(t, f.send(t, "POST", "/system/auth/scopes", admin, scopeJSON("T33R", "NORTE", "Otro", admin)), 409, `{"detail":"Proyecto existente"}`)
		if after := f.rows(t); after != before || !strings.Contains(after, "T33R/NORTE|Proyecto Norte|2026-11-03 11:00:00.123") {
			t.Fatalf("rows changed or wrong:\n%s\n%s", before, after)
		}
	})
	t.Run("only admins create projects", func(t *testing.T) {
		before := f.rows(t)
		expect(t, f.send(t, "POST", "/system/auth/scopes", ana, scopeJSON("T33R", "SUR", "x", ana)), 403, scopeForbidden)
		if f.rows(t) != before {
			t.Fatal("an analyst's request wrote rows")
		}
	})
}

func TestTenancyGrantsAndRevokesAccess(t *testing.T) {
	f := newTenancyFixture(t, "T33G")
	home := f.project(t, "T33G", "HOME")
	other := f.project(t, "T33G", "OTHER")
	admin := f.account(t, "admin", "admin", home)
	user := f.account(t, "viewer", "analista")

	t.Run("grant is idempotent and resolves at once", func(t *testing.T) {
		for range 2 {
			expect(t, f.send(t, "POST", "/system/auth/grants", admin, grantJSON(user, home)), 200, okTrue)
		}
		expect(t, f.s.do(t, req{path: "/system/auth/current-scope", user: user}), 200,
			`{"company_id":"T33G","project_id":"HOME","scope":"T33G/HOME"}`)
	})
	t.Run("revoke takes effect at once and keeps the session", func(t *testing.T) {
		expect(t, f.send(t, "DELETE", "/system/auth/grants", admin, grantJSON(user, home)), 200, okTrue)
		expect(t, f.s.do(t, req{path: "/system/auth/scopes", user: user}), 200, `[]`)
		expect(t, f.s.do(t, req{path: "/system/auth/current-scope", user: user}), 403,
			`{"detail":"Seleccione un proyecto autorizado mediante X-SIPGES-Scope o /select-project","projects":[]}`)
		if got := f.s.do(t, req{path: "/system/auth/me", user: user}); !strings.Contains(got.body, `"username":"`+user+`"`) {
			t.Fatalf("session lost: %s", got.body)
		}
		expect(t, f.send(t, "POST", "/system/auth/grants", admin, grantJSON(user, home)), 200, okTrue)
		expect(t, f.s.do(t, req{path: "/system/auth/current-scope", user: user}), 200,
			`{"company_id":"T33G","project_id":"HOME","scope":"T33G/HOME"}`)
	})
	t.Run("missing references answer 404 and change nothing", func(t *testing.T) {
		before := f.rows(t)
		for _, method := range []string{"POST", "DELETE"} {
			expect(t, f.send(t, method, "/system/auth/grants", admin, grantJSON("T33G-absent", home)), 404, `{"detail":"Usuario inexistente"}`)
			expect(t, f.send(t, method, "/system/auth/grants", admin, grantJSON(user, "NO/PE")), 404, `{"detail":"Proyecto inexistente"}`)
		}
		expect(t, f.send(t, "DELETE", "/system/auth/grants", admin, grantJSON(user, other)), 404, `{"detail":"Acceso inexistente"}`)
		if f.rows(t) != before {
			t.Fatal("rows changed")
		}
	})
	t.Run("a second revoke reports the absent grant", func(t *testing.T) {
		expect(t, f.send(t, "DELETE", "/system/auth/grants", admin, grantJSON(user, home)), 200, okTrue)
		expect(t, f.send(t, "DELETE", "/system/auth/grants", admin, grantJSON(user, home)), 404, `{"detail":"Acceso inexistente"}`)
	})
	t.Run("revoke bounds its lookup text", func(t *testing.T) {
		expect(t, f.send(t, "DELETE", "/system/auth/grants", admin, grantJSON("", home)), 422,
			`{"detail":[{"type":"custom","loc":["body"],"msg":"Invalid input"}]}`)
		expect(t, f.send(t, "DELETE", "/system/auth/grants", admin, grantJSON(strings.Repeat("u", 121), home)), 422,
			`{"detail":[{"type":"custom","loc":["body"],"msg":"Invalid input"}]}`)
	})
}

// independent-inputs.test.ts: NUL in any field is a 422 that changes no public state.
func TestTenancyRefusesNULWithoutStateChanges(t *testing.T) {
	f := newTenancyFixture(t, "T33N")
	home := f.project(t, "T33N", "HOME")
	admin := f.account(t, "admin", "admin", home)
	snapshot := func() string {
		var b strings.Builder
		for _, path := range []string{"/system/auth/scopes", "/system/auth/current-scope"} {
			r := f.s.do(t, req{path: path, user: admin})
			fmt.Fprintf(&b, "%d %s\n", r.status, r.body)
		}
		return b.String() + f.rows(t)
	}
	for _, body := range []string{
		grantJSON(admin+"\x00", home), grantJSON(admin, "T33N\x00/HOME"), grantJSON(admin, "T33N/HOME\x00"),
	} {
		before := snapshot()
		expect(t, f.send(t, "POST", "/system/auth/grants", admin, body), 422, nulBody)
		if snapshot() != before {
			t.Fatal("state changed")
		}
	}
	for _, body := range []string{scopeJSON("T33N", "NEW", "Synthetic", admin+"\x00"), scopeJSON("T33N", "NEW", "Synthetic\x00", admin)} {
		before := snapshot()
		expect(t, f.send(t, "POST", "/system/auth/scopes", admin, body), 422, nulBody)
		if snapshot() != before {
			t.Fatal("state changed")
		}
	}
}

// Cross-tenant attempts: a non-administrator cannot reach another project through the grant
// routes, the project choice, or the scope header; reads list only the caller's own grants.
func TestTenancyCrossTenantAttempts(t *testing.T) {
	f := newTenancyFixture(t, "T33X")
	mine := f.project(t, "T33X", "MINE")
	theirs := f.project(t, "T33Y", "THEIRS")
	admin := f.account(t, "admin", "admin", mine)
	ana := f.account(t, "ana", "analista", mine)
	reader := f.account(t, "reader", "consulta", mine)
	f.account(t, "owner", "analista", theirs)

	t.Run("an analyst cannot grant herself another company's project", func(t *testing.T) {
		before := f.rows(t)
		expect(t, f.send(t, "POST", "/system/auth/grants", ana, grantJSON(ana, theirs)), 403, grantForbidden)
		expect(t, f.send(t, "DELETE", "/system/auth/grants", ana, grantJSON(f.name("owner"), theirs)), 403, grantForbidden)
		expect(t, f.send(t, "POST", "/system/auth/scopes", ana, scopeJSON("T33Y", "MINE2", "x", ana)), 403, scopeForbidden)
		expect(t, f.send(t, "POST", "/system/auth/grants", reader, grantJSON(reader, theirs)), 403, `{"detail":"Rol de consulta: solo lectura"}`)
		if f.rows(t) != before {
			t.Fatal("a refused cross-tenant write changed rows")
		}
	})
	t.Run("another tenant's grants are never listed", func(t *testing.T) {
		mineOnly := "[" + scopesOf("T33X", "MINE", "Synthetic") + "]"
		for _, q := range []req{
			{path: "/system/auth/scopes", user: ana},
			{path: "/system/auth/scopes?username=" + f.name("owner"), user: ana},
			{path: "/system/auth/scopes?project_id=THEIRS", user: ana},
			{path: "/system/auth/scopes", user: ana, headers: map[string]string{"X-SIPGES-Scope": theirs}},
		} {
			expect(t, f.s.do(t, q), 200, mineOnly)
		}
		page := f.s.do(t, req{path: "/select-project", user: ana})
		if page.status != 200 || strings.Contains(page.body, "THEIRS") || !strings.Contains(page.body, `<option value="T33X/MINE">`) {
			t.Fatalf("select page %d %s", page.status, page.body)
		}
	})
	t.Run("choosing or naming an ungranted project is refused", func(t *testing.T) {
		res := f.s.do(t, req{method: "POST", path: "/select-project", user: ana, sameOrigin: true,
			headers: map[string]string{"Content-Type": "application/x-www-form-urlencoded"}, body: "scope=T33Y%2FTHEIRS"})
		expect(t, res, 403, `{"detail":"Proyecto no autorizado"}`)
		expect(t, f.s.do(t, req{path: "/system/auth/current-scope", user: ana, headers: map[string]string{"X-SIPGES-Scope": theirs}}), 403,
			`{"detail":"Seleccione un proyecto autorizado mediante X-SIPGES-Scope o /select-project","projects":["T33X/MINE"]}`)
	})
	t.Run("an administrator may grant into a project of another company", func(t *testing.T) {
		expect(t, f.send(t, "POST", "/system/auth/grants", admin, grantJSON(ana, theirs)), 200, okTrue)
		expect(t, f.s.do(t, req{path: "/system/auth/current-scope", user: ana, headers: map[string]string{"X-SIPGES-Scope": theirs}}), 200,
			`{"company_id":"T33Y","project_id":"THEIRS","scope":"T33Y/THEIRS"}`)
		expect(t, f.send(t, "DELETE", "/system/auth/grants", admin, grantJSON(ana, theirs)), 200, okTrue)
		expect(t, f.s.do(t, req{path: "/system/auth/current-scope", user: ana, headers: map[string]string{"X-SIPGES-Scope": theirs}}), 403,
			`{"detail":"Seleccione un proyecto autorizado mediante X-SIPGES-Scope o /select-project","projects":["T33X/MINE"]}`)
	})
}

func TestTenancySelectProject(t *testing.T) {
	f := newTenancyFixture(t, "T33S")
	one := f.project(t, "T33S", "ONE")
	f.exec(t, `INSERT INTO tenants (company_id, project_id, label) VALUES ('T33S', 'TWO', '<script>alert(1)</script>')`)
	admin := f.account(t, "admin", "admin", one, "T33S/TWO")
	form := map[string]string{"Content-Type": "application/x-www-form-urlencoded"}

	t.Run("anonymous visitors go to the login page", func(t *testing.T) {
		client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
		res, err := client.Get(f.s.url + "/select-project")
		if err != nil {
			t.Fatal(err)
		}
		_ = res.Body.Close()
		if res.StatusCode != http.StatusSeeOther || res.Header.Get("Location") != "/login" {
			t.Fatalf("%d %q", res.StatusCode, res.Header.Get("Location"))
		}
	})
	t.Run("lists granted projects with escaped labels", func(t *testing.T) {
		page := f.s.do(t, req{path: "/select-project", user: admin})
		if page.status != 200 || !strings.Contains(page.body,
			`<option value="T33S/TWO">&lt;script&gt;alert(1)&lt;/script&gt; (T33S/TWO)</option>`) || strings.Contains(page.body, "<script>") {
			t.Fatalf("%d %s", page.status, page.body)
		}
	})
	t.Run("a granted choice sets the scope cookie", func(t *testing.T) {
		r, _ := http.NewRequestWithContext(t.Context(), http.MethodPost, f.s.url+"/select-project", strings.NewReader("scope=T33S%2FTWO"))
		r.Header.Set("Cookie", "sipges_session="+tokens[admin])
		r.Header.Set("Origin", f.s.url)
		r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
		res, err := client.Do(r)
		if err != nil {
			t.Fatal(err)
		}
		_ = res.Body.Close()
		cookie := res.Header.Get("Set-Cookie")
		if res.StatusCode != http.StatusSeeOther || res.Header.Get("Location") != "/" ||
			cookie != "sipges_scope=T33S%2FTWO; Max-Age=28800; Path=/; HttpOnly; Secure; SameSite=Strict" {
			t.Fatalf("%d %q %q", res.StatusCode, res.Header.Get("Location"), cookie)
		}
		expect(t, f.s.do(t, req{path: "/system/auth/current-scope", headers: map[string]string{
			"Cookie": "sipges_session=" + tokens[admin] + "; " + strings.Split(cookie, ";")[0]}}), 200,
			`{"company_id":"T33S","project_id":"TWO","scope":"T33S/TWO"}`)
	})
	t.Run("refusals", func(t *testing.T) {
		expect(t, f.s.do(t, req{method: "POST", path: "/select-project", sameOrigin: true, headers: form, body: "scope=T33S%2FONE"}),
			401, `{"detail":"Unauthorized"}`)
		expect(t, f.s.do(t, req{method: "POST", path: "/select-project", user: admin, headers: form, body: "scope=T33S%2FONE"}),
			403, badOrigin)
		expect(t, f.s.do(t, req{method: "POST", path: "/select-project", user: admin, sameOrigin: true, headers: form}),
			422, `{"detail":[{"type":"missing","loc":["body","scope"],"msg":"Field required"}]}`)
	})
}

// Concurrent identical writes leave exactly one row: creation answers 200 once and 409 for the
// rest, a repeated grant is 200 for all, and only one of several revokes deletes.
func TestTenancyConcurrentWrites(t *testing.T) {
	f := newTenancyFixture(t, "T33K")
	admin := f.account(t, "admin", "admin", f.project(t, "T33K", "HOME"))
	user := f.account(t, "user", "analista")
	race := func(method, path, body string) map[int]int {
		var mu sync.Mutex
		statuses := map[int]int{}
		var wg sync.WaitGroup
		for range 8 {
			wg.Go(func() {
				r := f.send(t, method, path, admin, body)
				mu.Lock()
				statuses[r.status]++
				mu.Unlock()
			})
		}
		wg.Wait()
		return statuses
	}
	if got := race("POST", "/system/auth/scopes", scopeJSON("T33K", "NEW", "x", user)); got[200] != 1 || got[409] != 7 {
		t.Fatalf("create statuses %v", got)
	}
	if got := race("POST", "/system/auth/grants", grantJSON(admin, "T33K/NEW")); got[200] != 8 {
		t.Fatalf("grant statuses %v", got)
	}
	if got := race("DELETE", "/system/auth/grants", grantJSON(user, "T33K/NEW")); got[200] != 1 || got[404] != 7 {
		t.Fatalf("revoke statuses %v", got)
	}
	var tenants, grants int
	if err := f.conn.QueryRow(t.Context(), `SELECT (SELECT count(*) FROM tenants WHERE tenant_id = 'T33K/NEW'),
	  (SELECT count(*) FROM grants WHERE tenant_id = 'T33K/NEW')`).Scan(&tenants, &grants); err != nil {
		t.Fatal(err)
	}
	if tenants != 1 || grants != 1 {
		t.Fatalf("tenants %d grants %d", tenants, grants)
	}
}

// createTenantWithGrant is one transaction: when the grant cannot be written (an account
// removed between the check and the insert), the tenant row is rolled back with it.
func TestTenancyCreationRollsBackWhenTheGrantFails(t *testing.T) {
	f := newTenancyFixture(t, "T33T")
	pool, err := pgxpool.New(t.Context(), scratch.URL)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	store := tenancy.NewStore(pool)
	_, err = store.CreateTenantWithGrant(t.Context(), domain.NewTenant{
		Scope: domain.Scope{CompanyID: "T33T", ProjectID: "GONE"}, Label: "x", Username: "T33T-removed",
	}, t0)
	if err == nil {
		t.Fatal("want the foreign key error")
	}
	if rows := f.rows(t); rows != " / " {
		t.Fatalf("rows left behind: %q", rows)
	}
}
