package app_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/identity/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/identity/domain"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/identity/infrastructure"
)

// Ported from apps/api/test/identity/{auth-http,hardening}.test.ts and
// test/tenancy/access-lifecycle.test.ts, plus the T35 probes.

const (
	restricted     = `{"detail":"Administración de cuentas restringida"}`
	badUser        = `{"detail":"Usuario inválido"}`
	noUser         = `{"detail":"Usuario inexistente"}`
	lastAdmin      = `{"detail":"No se permite desactivar el último administrador"}`
	selfReset      = `{"detail":"No puede restablecer su propio MFA; pida a otro administrador"}`
	userOutOfScope = `{"detail":"Usuario fuera del proyecto activo"}`
	existing       = `{"detail":"Usuario existente"}`
)

// clearedCookies is what logout and a self-deactivation send, in order.
var clearedCookies = []string{
	"sipges_session=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Strict",
	"sipges_scope=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Strict",
}

type accountsFixture struct {
	*loginFixture
	project string
}

func newAccountsFixture(t *testing.T, prefix string) accountsFixture {
	t.Helper()
	f := accountsFixture{newLoginFixture(t, prefix), prefix + "/PRJ"}
	f.exec(t, `INSERT INTO tenants (company_id, project_id, label) VALUES ($1, 'PRJ', 'Synthetic')`, prefix)
	return f
}

// session stores an account with MFA, a session and the fixture's project.
func (f accountsFixture) session(t *testing.T, suffix, role string, granted bool) string {
	t.Helper()
	user := f.prefix + "-" + suffix
	f.exec(t, `INSERT INTO users (username, full_name, password_hash, role, active, totp_enabled, totp_secret_sealed, totp_last_step)
	           VALUES ($1, 'Synthetic', 'x', $2, true, true, 'v1.sealed', 7)`, user, role)
	tokens[user] = newToken()
	f.exec(t, `INSERT INTO sessions (token_hash, username, expires_at) VALUES ($1, $2, $3)`,
		infrastructure.HashToken(tokens[user]), user, t0.Add(sessionTTL))
	if granted {
		f.exec(t, `INSERT INTO grants (username, tenant_id) VALUES ($1, $2)`, user, f.project)
	}
	return user
}

func (f accountsFixture) send(t *testing.T, path, user, body string) reply {
	t.Helper()
	return f.s.do(t, req{method: "POST", path: path, user: user, sameOrigin: true,
		headers: map[string]string{"Content-Type": "application/json", "X-SIPGES-Scope": f.project}, body: body})
}

func (f accountsFixture) postCookies(t *testing.T, path, user string) (reply, []string) {
	t.Helper()
	r, err := http.NewRequestWithContext(t.Context(), http.MethodPost, f.s.url+path, nil)
	if err != nil {
		t.Fatal(err)
	}
	r.Header.Set("Origin", f.s.url)
	r.Header.Set("X-SIPGES-Scope", f.project)
	if user != "" {
		r.Header.Set("Cookie", "sipges_session="+tokens[user])
	}
	res, err := http.DefaultClient.Do(r)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = res.Body.Close() }()
	var body strings.Builder
	buf := make([]byte, 4096)
	for {
		n, err := res.Body.Read(buf)
		body.Write(buf[:n])
		if err != nil {
			break
		}
	}
	return reply{res.StatusCode, body.String()}, res.Header.Values("Set-Cookie")
}

func sameList(a, b []string) bool { return strings.Join(a, "\n") == strings.Join(b, "\n") }

func TestLogoutEndsTheSessionAndClearsBothCookies(t *testing.T) {
	f := newAccountsFixture(t, "logout")
	user := f.session(t, "user", "analista", true)
	got, cookies := f.postCookies(t, "/logout", user)
	expect(t, got, http.StatusOK, okTrue)
	if !sameList(cookies, clearedCookies) {
		t.Fatalf("Set-Cookie = %q", cookies)
	}
	if f.sessions(t, user) != 0 {
		t.Fatal("the session row survived")
	}
	expect(t, f.s.do(t, req{path: "/system/auth/me", user: user}), http.StatusOK, "null")
}

func TestLogoutWithoutASessionStillClears(t *testing.T) {
	f := newAccountsFixture(t, "logout-anon")
	other := f.session(t, "other", "analista", true)
	got, cookies := f.postCookies(t, "/logout", "")
	expect(t, got, http.StatusOK, okTrue)
	if !sameList(cookies, clearedCookies) {
		t.Fatalf("Set-Cookie = %q", cookies)
	}
	tokens["stranger"] = newToken()
	got, _ = f.postCookies(t, "/logout", "stranger")
	expect(t, got, http.StatusOK, okTrue)
	if f.sessions(t, other) != 1 {
		t.Fatal("logout touched another session")
	}
	expect(t, f.s.do(t, req{method: "POST", path: "/logout"}), http.StatusForbidden, badOrigin)
}

func TestListAccounts(t *testing.T) {
	f := newAccountsFixture(t, "list")
	admin := f.session(t, "admin", "admin", true)
	reader := f.session(t, "reader", "consulta", true)
	f.exec(t, `UPDATE users SET created_at = '2026-10-12T12:00:00.789Z', google_email = 'ana@example.org', active = false WHERE username = $1`, reader)
	got := f.s.do(t, req{path: "/system/auth/accounts", user: admin, headers: map[string]string{"X-SIPGES-Scope": f.project}})
	if got.status != http.StatusOK {
		t.Fatalf("got %d %s", got.status, got.body)
	}
	var list []map[string]any
	if err := json.Unmarshal([]byte(got.body), &list); err != nil {
		t.Fatal(err)
	}
	var row map[string]any
	for _, a := range list {
		if a["username"] == reader {
			row = a
		}
	}
	want := `{"active":0,"created_at":"2026-10-12T12:00:00Z","full_name":"Synthetic","google_email":"ana@example.org","role":"consulta","username":"` + reader + `"}`
	if text := jsonText(row); text != want {
		t.Fatalf("row %s", text)
	}
	if strings.Contains(got.body, "password") || strings.Contains(got.body, "totp") {
		t.Fatalf("the list leaks a secret field: %s", got.body)
	}
	expect(t, f.s.do(t, req{path: "/system/auth/accounts", headers: map[string]string{"X-SIPGES-Scope": f.project}}), http.StatusUnauthorized, signIn)
}

func TestCreateAccount(t *testing.T) {
	f := newAccountsFixture(t, "create")
	admin := f.session(t, "admin", "admin", true)
	name := func(s string) string { return f.prefix + "." + s }
	body := func(user, role, password string) string {
		return `{"username":"` + user + `","full_name":"Ana Pérez","password":"` + password + `"` + role + `}`
	}
	expect(t, f.send(t, "/system/auth/accounts", admin, body(name("ana"), `,"role":"analista"`, "twelve-chars")),
		http.StatusOK, `{"ok":true,"username":"`+name("ana")+`","role":"analista"}`)
	expect(t, f.send(t, "/system/auth/accounts", admin, body(name("def"), "", "twelve-chars")),
		http.StatusOK, `{"ok":true,"username":"`+name("def")+`","role":"consulta"}`)
	expect(t, f.send(t, "/system/auth/accounts", admin, body(name("ana"), "", "twelve-chars")), http.StatusConflict, existing)
	expect(t, f.send(t, "/system/auth/accounts", admin, body("Ana", "", "twelve-chars")), http.StatusUnprocessableEntity, badUser)
	expect(t, f.send(t, "/system/auth/accounts", admin, body(name("r"), `,"role":"root"`, "twelve-chars")), http.StatusUnprocessableEntity, `{"detail":"Rol no válido"}`)
	expect(t, f.send(t, "/system/auth/accounts", admin, body(name("s"), "", "short")), http.StatusUnprocessableEntity, `{"detail":"Contraseña demasiado corta: mínimo 12 caracteres"}`)
	expect(t, f.send(t, "/system/auth/accounts", admin, `{"role":null}`), http.StatusUnprocessableEntity,
		`{"detail":[{"type":"missing","loc":["body","username"],"msg":"Field required"},{"type":"missing","loc":["body","full_name"],"msg":"Field required"},{"type":"missing","loc":["body","password"],"msg":"Field required"},{"type":"invalid_type","loc":["body","role"],"msg":"Invalid input: expected string, received null"}]}`)

	if n := f.count(t, `SELECT count(*) FROM users WHERE username = $1 AND full_name = 'Ana Pérez' AND active AND NOT totp_enabled AND created_at = $2`, name("ana"), f.s.clock.now()); n != 1 {
		t.Fatal("the stored row differs")
	}
	// The account signs in with the password, hashed by Go.
	if got := f.login(t, name("ana"), "twelve-chars"); got.status != http.StatusOK {
		t.Fatalf("login: %d %s", got.status, got.body)
	}
	reader := f.session(t, "reader", "consulta", true)
	expect(t, f.send(t, "/system/auth/accounts", reader, body(name("x"), "", "twelve-chars")), http.StatusForbidden, restricted)
}

func TestDeactivateAccount(t *testing.T) {
	f := newAccountsFixture(t, "deact")
	admin := f.session(t, "admin", "admin", true)
	target := f.session(t, "target", "analista", true)
	path := func(user string) string { return "/system/auth/accounts/" + user + "/deactivate" }

	expect(t, f.send(t, path(strings.ToUpper(target)), admin, ""), http.StatusOK, okTrue)
	if n := f.count(t, `SELECT count(*) FROM users WHERE username = $1 AND NOT active`, target); n != 1 || f.sessions(t, target) != 0 {
		t.Fatal("the account stayed active or kept its sessions")
	}
	expect(t, f.send(t, path(target), admin, ""), http.StatusOK, okTrue) // repeated
	expect(t, f.send(t, path("nobody-here"), admin, ""), http.StatusNotFound, noUser)
	expect(t, f.send(t, path("%00"), admin, ""), http.StatusUnprocessableEntity, badUser)
	expect(t, f.send(t, path("%20"), admin, ""), http.StatusUnprocessableEntity, badUser)
	expect(t, f.send(t, path(strings.Repeat("a", 121)), admin, ""), http.StatusUnprocessableEntity, badUser)
	reader := f.session(t, "reader", "consulta", true)
	expect(t, f.send(t, path(admin), reader, ""), http.StatusForbidden, restricted)
}

func TestDeactivateRefusesTheLastAdministratorAndClearsOwnCookies(t *testing.T) {
	f := newAccountsFixture(t, "lastadm")
	// Only this test's administrators stay active.
	f.exec(t, `UPDATE users SET active = false WHERE role = 'admin'`)
	t.Cleanup(func() {
		_, _ = f.conn.Exec(context.Background(), `UPDATE users SET active = true WHERE role = 'admin' AND username NOT LIKE 'lastadm%' AND username <> 'gone'`)
	})
	first := f.session(t, "first", "admin", true)
	second := f.session(t, "second", "admin", true)

	got, cookies := f.postCookies(t, "/system/auth/accounts/"+strings.ToUpper(second)+"/deactivate", second)
	expect(t, got, http.StatusOK, okTrue)
	if !sameList(cookies, clearedCookies) {
		t.Fatalf("self-deactivation: Set-Cookie = %q", cookies)
	}
	got, cookies = f.postCookies(t, "/system/auth/accounts/"+first+"/deactivate", first)
	expect(t, got, http.StatusConflict, lastAdmin)
	if len(cookies) != 0 {
		t.Fatalf("a refusal cleared cookies: %q", cookies)
	}
	if n := f.count(t, `SELECT count(*) FROM users WHERE username = $1 AND active`, first); n != 1 {
		t.Fatal("the last administrator was deactivated")
	}
}

func TestResetMFA(t *testing.T) {
	f := newAccountsFixture(t, "reset")
	admin := f.session(t, "admin", "admin", true)
	target := f.session(t, "target", "analista", true)
	foreign := f.session(t, "foreign", "analista", false)
	path := func(user string) string { return "/system/auth/accounts/" + user + "/reset-mfa" }

	expect(t, f.send(t, path(admin), admin, ""), http.StatusForbidden, selfReset)
	expect(t, f.send(t, path(foreign), admin, ""), http.StatusForbidden, userOutOfScope)
	expect(t, f.send(t, path("nobody-here"), admin, ""), http.StatusNotFound, noUser)
	expect(t, f.send(t, path("%00"), admin, ""), http.StatusUnprocessableEntity, badUser)
	if n := f.count(t, `SELECT count(*) FROM users WHERE username = $1 AND totp_enabled`, foreign); n != 1 || f.sessions(t, foreign) != 1 {
		t.Fatal("a refused reset changed the account")
	}

	expect(t, f.send(t, path(strings.ToUpper(target)), admin, ""), http.StatusOK, `{"ok":true,"username":"`+target+`"}`)
	if n := f.count(t, `SELECT count(*) FROM users WHERE username = $1 AND NOT totp_enabled AND totp_secret_sealed IS NULL AND totp_last_step IS NULL`, target); n != 1 {
		t.Fatal("the factor was not cleared")
	}
	if f.sessions(t, target) != 0 {
		t.Fatal("the sessions survived")
	}
	if n := f.count(t, `SELECT count(*) FROM audit WHERE tenant_id = $1 AND module = 'Cuentas' AND record_id = $2 AND action = 'MFA_RESET'
	      AND detail = $3 AND ts = $4`, f.project, target, "MFA restablecido por "+admin+"; sesiones revocadas", f.s.clock.now()); n != 1 {
		t.Fatal("the audit row differs")
	}
	if n := f.count(t, `SELECT count(*) FROM audit WHERE action = 'MFA_RESET' AND tenant_id <> $1 AND record_id = $2`, f.project, target); n != 0 {
		t.Fatal("the audit row reached another project")
	}
}

func TestSessionsEndWhenTheirAccountIsDeactivatedDuringThem(t *testing.T) {
	f := newAccountsFixture(t, "lifecycle")
	admin := f.session(t, "admin", "admin", true)
	f.exec(t, `INSERT INTO users (username, full_name, password_hash, role) VALUES ($1, 'Synthetic', $2, 'analista')`, f.prefix+"-user", newHash(t))
	user := f.prefix + "-user"
	got := f.post(t, url.Values{"username": {user}, "password": {loginPassword}}, nil)
	token := loginCookie.FindStringSubmatch(got.header.Get("Set-Cookie"))[1]
	tokens[user] = token
	expect(t, f.send(t, "/system/auth/accounts/"+user+"/deactivate", admin, ""), http.StatusOK, okTrue)
	expect(t, f.s.do(t, req{path: "/system/auth/me", user: user}), http.StatusOK, "null")
	expect(t, f.login(t, user, loginPassword).reply, http.StatusUnauthorized, badCredentials)
}

func TestBootstrapAdminOnlyActsOnAnEmptyInstallation(t *testing.T) {
	f := newAccountsFixture(t, "bootstrap")
	store := infrastructure.Store{DB: f.pool(t)}
	service := application.NewService(application.Deps{Store: store, Accounts: store, Hasher: infrastructure.Passwords{}, Tokens: infrastructure.Tokens{}})
	admin := application.BootstrapAdmin{Username: "bootstrap-admin", Password: "short", FullName: "Synthetic"}
	if err := service.BootstrapAdmin(t.Context(), admin); err != nil {
		t.Fatalf("an installation with users must not need a password: %v", err)
	}
	if n := f.count(t, `SELECT count(*) FROM users WHERE username = 'bootstrap-admin'`); n != 0 {
		t.Fatal("a bootstrap ran on a used installation")
	}
}

func (f accountsFixture) pool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	pool, err := pgxpool.New(t.Context(), scratch.URL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func TestBootstrapAdminOnAnEmptyInstallation(t *testing.T) {
	accounts := &emptyAccounts{}
	service := application.NewService(application.Deps{Accounts: accounts, Hasher: infrastructure.Passwords{}, Tokens: infrastructure.Tokens{}})
	short := application.BootstrapAdmin{Username: "admin", Password: strings.Repeat("😀", 5) + "x", FullName: "Administrator"}
	if err := service.BootstrapAdmin(t.Context(), short); err == nil || err.Error() != "Configure SIPGES_ADMIN_PASSWORD (mínimo 12 caracteres)" {
		t.Fatalf("err = %v", err)
	}
	if err := service.BootstrapAdmin(t.Context(), application.BootstrapAdmin{Username: "admin", Password: loginPassword, FullName: "Administrator"}); err != nil {
		t.Fatal(err)
	}
	if accounts.created.Role != "admin" || !(infrastructure.Passwords{}).Verify(loginPassword, accounts.hash) {
		t.Fatalf("created %+v", accounts.created)
	}
}

// emptyAccounts is an installation without users.
type emptyAccounts struct {
	application.AccountStore
	created domain.NewAccount
	hash    string
}

func (*emptyAccounts) HasUsers(context.Context) (bool, error) { return false, nil }

func (e *emptyAccounts) CreateUser(_ context.Context, account domain.NewAccount, hash string, _ time.Time) (bool, error) {
	e.created, e.hash = account, hash
	return true, nil
}
