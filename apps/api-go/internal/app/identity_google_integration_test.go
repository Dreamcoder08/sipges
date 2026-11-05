package app_test

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/app"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/identity/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/identity/infrastructure"
)

// Ported from apps/api/test/identity/google-sign-in.test.ts (ADR 0010), plus the T35 probes. The
// fake below stands in for Google's token endpoint and signs nothing, as SIPGES trusts TLS there.

const googleClient = "client.apps.example"

var (
	flowCookie    = regexp.MustCompile(`^sipges_google_flow=([A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}); Max-Age=600; Path=/auth/google; HttpOnly; Secure; SameSite=Lax$`)
	flowCleared   = "sipges_google_flow=; Max-Age=0; Path=/auth/google; HttpOnly; Secure; SameSite=Lax"
	sessionCookie = regexp.MustCompile(`^sipges_session=([0-9a-f]{64}); Max-Age=28800; Path=/; HttpOnly; Secure; SameSite=Strict$`)
)

// fakeGoogle answers the token endpoint with an ID token for the current email, echoing the
// nonce the flow cookie holds.
type fakeGoogle struct {
	mu       sync.Mutex
	email    string
	nonce    string
	at       time.Time
	status   int
	requests []url.Values
}

func (g *fakeGoogle) RoundTrip(r *http.Request) (*http.Response, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	body, _ := io.ReadAll(r.Body)
	form, _ := url.ParseQuery(string(body))
	g.requests = append(g.requests, form)
	claims, _ := json.Marshal(map[string]any{
		"iss": "https://accounts.google.com", "aud": googleClient, "exp": g.at.Unix() + 3600, "iat": g.at.Unix(),
		"nonce": g.nonce, "email": g.email, "email_verified": true, "name": "Synthetic",
	})
	token, _ := json.Marshal(map[string]string{"id_token": "e30." + base64.RawURLEncoding.EncodeToString(claims) + ".c2ln"})
	return &http.Response{StatusCode: g.status, Body: io.NopCloser(strings.NewReader(string(token))), Header: http.Header{}}, nil
}

type googleFixture struct {
	accountsFixture
	google *fakeGoogle
}

func newGoogleFixture(t *testing.T, prefix string) googleFixture {
	t.Helper()
	t.Setenv("SIPGES_GOOGLE_CLIENT_ID", googleClient)
	t.Setenv("SIPGES_GOOGLE_CLIENT_SECRET", "synthetic-secret")
	g := &fakeGoogle{email: prefix + "@example.com", status: http.StatusOK}
	restore := app.SetGoogleTransport(g)
	t.Cleanup(restore)
	f := googleFixture{newAccountsFixture(t, prefix), g}
	g.at = f.s.clock.now()
	return f
}

type browserReply struct {
	status   int
	location string
	cookies  []string
	body     string
}

// browser sends a GET without following redirects.
func (f googleFixture) browser(t *testing.T, path, cookie string) browserReply {
	t.Helper()
	r, err := http.NewRequestWithContext(t.Context(), http.MethodGet, f.s.url+path, nil)
	if err != nil {
		t.Fatal(err)
	}
	if cookie != "" {
		r.Header.Set("Cookie", cookie)
	}
	client := http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	res, err := client.Do(r)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = res.Body.Close() }()
	body, _ := io.ReadAll(res.Body)
	return browserReply{res.StatusCode, res.Header.Get("Location"), res.Header.Values("Set-Cookie"), string(body)}
}

// flow starts a sign-in: the cookie, its parts, and the state Google would echo.
type flow struct {
	cookie, state, nonce, verifier string
	location                       *url.URL
}

func (f googleFixture) start(t *testing.T) flow {
	t.Helper()
	got := f.browser(t, "/auth/google", "")
	if got.status != http.StatusFound || len(got.cookies) != 1 {
		t.Fatalf("start: %d %q", got.status, got.cookies)
	}
	match := flowCookie.FindStringSubmatch(got.cookies[0])
	if match == nil {
		t.Fatalf("flow cookie %q", got.cookies[0])
	}
	location, err := url.Parse(got.location)
	if err != nil {
		t.Fatal(err)
	}
	parts := strings.Split(match[1], ".")
	f.google.mu.Lock()
	f.google.nonce = parts[1]
	f.google.mu.Unlock()
	return flow{"sipges_google_flow=" + match[1], parts[0], parts[1], parts[2], location}
}

func (f googleFixture) back(t *testing.T, fl flow, code string) browserReply {
	t.Helper()
	return f.browser(t, "/auth/google/callback?state="+fl.state+"&code="+code, fl.cookie)
}

func (f googleFixture) link(t *testing.T, admin, user, email string) reply {
	t.Helper()
	body, _ := json.Marshal(map[string]string{"email": email})
	return f.send(t, "/system/auth/accounts/"+user+"/google", admin, string(body))
}

func TestGoogleSignInOpensASessionThatCountsAsTheSecondFactor(t *testing.T) {
	f := newGoogleFixture(t, "googleok")
	admin := f.session(t, "admin", "admin", true)
	user := f.session(t, "user", "analista", true)
	f.exec(t, `UPDATE users SET totp_enabled = false WHERE username = $1`, user)
	expect(t, f.link(t, admin, user, " GoogleOK@Example.com "), http.StatusOK,
		`{"ok":true,"username":"`+user+`","google_email":"googleok@example.com"}`)

	fl := f.start(t)
	q := fl.location.Query()
	if fl.location.Host != "accounts.google.com" || q.Get("redirect_uri") != "http://"+f.s.addr+"/auth/google/callback" && q.Get("redirect_uri") != "https://"+f.s.addr+"/auth/google/callback" {
		t.Fatalf("location %s", fl.location)
	}
	if q.Get("state") != fl.state || q.Get("nonce") != fl.nonce {
		t.Fatal("the redirect does not carry the cookie's state and nonce")
	}

	got := f.back(t, fl, "synthetic-code")
	if got.status != http.StatusFound || got.location != "/" || len(got.cookies) != 2 || got.cookies[0] != flowCleared {
		t.Fatalf("callback: %+v", got)
	}
	match := sessionCookie.FindStringSubmatch(got.cookies[1])
	if match == nil {
		t.Fatalf("session cookie %q", got.cookies[1])
	}
	if n := f.count(t, `SELECT count(*) FROM sessions WHERE token_hash = $1 AND username = $2 AND via_google`, infrastructure.HashToken(match[1]), user); n != 1 {
		t.Fatal("the session row differs")
	}
	sent := f.google.requests[0]
	if sent.Get("code") != "synthetic-code" || sent.Get("code_verifier") != fl.verifier || sent.Get("redirect_uri") != q.Get("redirect_uri") {
		t.Fatalf("token request %v", sent)
	}
	// With MFA required, the Google session passes and a password session does not.
	mfa := start(t, true)
	tokens[user] = match[1]
	if got := mfa.do(t, req{path: "/system/auth/scopes", user: user}); got.status != http.StatusOK {
		t.Fatalf("scopes: %d %s", got.status, got.body)
	}
}

func TestGoogleCallbackRefusesAMissingForeignOrReplayedState(t *testing.T) {
	f := newGoogleFixture(t, "googlestate")
	admin := f.session(t, "admin", "admin", true)
	user := f.session(t, "user", "analista", true)
	if got := f.link(t, admin, user, "googlestate@example.com"); got.status != http.StatusOK {
		t.Fatalf("got %d %s", got.status, got.body)
	}

	fl := f.start(t)
	cases := map[string]string{
		"no cookie":         f.browser(t, "/auth/google/callback?state="+fl.state+"&code=c", "").location,
		"another state":     f.browser(t, "/auth/google/callback?state="+strings.Repeat("x", 43)+"&code=c", fl.cookie).location,
		"no state":          f.browser(t, "/auth/google/callback?code=c", fl.cookie).location,
		"malformed cookie":  f.browser(t, "/auth/google/callback?state=a&code=c", "sipges_google_flow=a.b.c").location,
		"cookie with parts": f.browser(t, "/auth/google/callback?state="+fl.state+"&code=c", "sipges_google_flow="+fl.state).location,
	}
	for name, location := range cases {
		if location != "/login?google=expired" {
			t.Errorf("%s: %q", name, location)
		}
	}
	if len(f.google.requests) != 0 {
		t.Fatal("a refused state reached Google")
	}
	if got := f.back(t, fl, "c"); got.location != "/" {
		t.Fatalf("first use: %q", got.location)
	}
	// The browser dropped the cookie: the callback cannot run twice.
	if got := f.browser(t, "/auth/google/callback?state="+fl.state+"&code=c", ""); got.location != "/login?google=expired" {
		t.Fatalf("replay: %q", got.location)
	}
}

func TestGoogleCallbackReportsCancelledAndFailed(t *testing.T) {
	f := newGoogleFixture(t, "googlefail")
	fl := f.start(t)
	got := f.browser(t, "/auth/google/callback?state="+fl.state+"&error=access_denied", fl.cookie)
	if got.location != "/login?google=cancelled" || len(got.cookies) != 1 || got.cookies[0] != flowCleared {
		t.Fatalf("cancelled: %+v", got)
	}
	if got := f.browser(t, "/auth/google/callback?state="+fl.state+"&error=x&code=c", fl.cookie); got.location != "/login?google=cancelled" {
		t.Fatalf("error with a code: %q", got.location)
	}
	if got := f.browser(t, "/auth/google/callback?state="+fl.state, fl.cookie); got.location != "/login?google=cancelled" {
		t.Fatalf("no code: %q", got.location)
	}
	f.google.status = http.StatusBadRequest
	got = f.back(t, fl, "c")
	if got.location != "/login?google=failed" || len(got.cookies) != 1 {
		t.Fatalf("failed: %+v", got)
	}
}

func TestGoogleAdmitsOnlyLinkedActiveAccounts(t *testing.T) {
	f := newGoogleFixture(t, "googlelink")
	admin := f.session(t, "admin", "admin", true)
	user := f.session(t, "user", "analista", true)

	if got := f.back(t, f.start(t), "c"); got.location != "/login?google=not_linked" || len(got.cookies) != 1 {
		t.Fatalf("unknown: %+v", got)
	}
	if got := f.link(t, admin, user, "googlelink@example.com"); got.status != http.StatusOK {
		t.Fatalf("got %d %s", got.status, got.body)
	}
	if got := f.send(t, "/system/auth/accounts/"+user+"/deactivate", admin, ""); got.status != http.StatusOK {
		t.Fatalf("got %d %s", got.status, got.body)
	}
	if got := f.back(t, f.start(t), "c"); got.location != "/login?google=not_linked" {
		t.Fatalf("inactive: %+v", got)
	}
	f.google.email = "otra.persona@example.com"
	if got := f.back(t, f.start(t), "c"); got.location != "/login?google=not_linked" {
		t.Fatalf("stranger: %+v", got)
	}
	if n := f.count(t, `SELECT count(*) FROM sessions WHERE username = $1`, user); n != 0 {
		t.Fatal("a refused sign-in opened a session")
	}
}

func TestGoogleLinksAreManagedByAdministratorsOneAccountPerAddress(t *testing.T) {
	f := newGoogleFixture(t, "googleadmin")
	admin := f.session(t, "admin", "admin", true)
	first := f.session(t, "first", "analista", true)
	second := f.session(t, "second", "analista", true)
	const invalidEmail = `{"detail":"Correo de Google inválido"}`
	if got := f.link(t, admin, first, "persona@example.com"); got.status != http.StatusOK {
		t.Fatalf("got %d %s", got.status, got.body)
	}
	expect(t, f.link(t, admin, second, "PERSONA@example.com"), http.StatusConflict, `{"detail":"Ese correo de Google ya está vinculado a otra cuenta"}`)
	expect(t, f.link(t, admin, second, "no-es-correo"), http.StatusUnprocessableEntity, invalidEmail)
	expect(t, f.link(t, admin, second, "a\x00b@example.com"), http.StatusUnprocessableEntity, invalidEmail)
	expect(t, f.link(t, admin, second, "a b@example.com"), http.StatusUnprocessableEntity, invalidEmail)
	expect(t, f.link(t, admin, second, strings.Repeat("a", 250)+"@b.co"), http.StatusUnprocessableEntity, invalidEmail)
	expect(t, f.link(t, admin, "nadie", "nadie@example.com"), http.StatusNotFound, noUser)
	expect(t, f.link(t, admin, "%00", "x@example.com"), http.StatusUnprocessableEntity, badUser)
	expect(t, f.link(t, second, second, "yo@example.com"), http.StatusForbidden, restricted)
	expect(t, f.send(t, "/system/auth/accounts/"+second+"/google", admin, `{}`), http.StatusUnprocessableEntity,
		`{"detail":[{"type":"missing","loc":["body","email"],"msg":"Field required"}]}`)
}

func TestGoogleSessionsEndWhenTheAddressChanges(t *testing.T) {
	f := newGoogleFixture(t, "googlechange")
	admin := f.session(t, "admin", "admin", true)
	user := f.session(t, "user", "analista", true)
	if got := f.link(t, admin, user, "googlechange@example.com"); got.status != http.StatusOK {
		t.Fatalf("got %d %s", got.status, got.body)
	}
	got := f.back(t, f.start(t), "c")
	google := sessionCookie.FindStringSubmatch(got.cookies[1])[1]

	// The same address again ends nothing.
	if got := f.link(t, admin, user, "GoogleChange@example.com"); got.status != http.StatusOK {
		t.Fatalf("got %d %s", got.status, got.body)
	}
	if n := f.count(t, `SELECT count(*) FROM sessions WHERE username = $1 AND via_google`, user); n != 1 {
		t.Fatal("re-linking the same address ended the session")
	}
	expect(t, f.link(t, admin, user, "   "), http.StatusOK, `{"ok":true,"username":"`+user+`","google_email":null}`)
	if n := f.count(t, `SELECT count(*) FROM sessions WHERE token_hash = $1`, infrastructure.HashToken(google)); n != 0 {
		t.Fatal("the Google session outlived its link")
	}
	if f.sessions(t, user) != 1 {
		t.Fatal("the password session did not survive")
	}
	if got := f.back(t, f.start(t), "c"); got.location != "/login?google=not_linked" {
		t.Fatalf("after the unlink: %+v", got)
	}
}

func TestGoogleRoutesAreHiddenWithoutAClient(t *testing.T) {
	f := newAccountsFixture(t, "googlehidden")
	expect(t, f.s.do(t, req{path: "/auth/google"}), http.StatusNotFound, notFound)
	expect(t, f.s.do(t, req{path: "/auth/google/callback?state=a&code=b"}), http.StatusNotFound, notFound)
	expect(t, f.s.do(t, req{path: "/system/auth/providers"}), http.StatusOK, `{"google":false}`)
	admin := f.session(t, "admin", "admin", true)
	user := f.session(t, "user", "analista", true)
	expect(t, f.send(t, "/system/auth/accounts/"+user+"/google", admin, `{"email":"x@example.com"}`), http.StatusOK,
		`{"ok":true,"username":"`+user+`","google_email":"x@example.com"}`)
}

func TestGoogleStartRefusesAHostItCannotReturnTo(t *testing.T) {
	f := newGoogleFixture(t, "googlehost")
	r, err := http.NewRequestWithContext(t.Context(), http.MethodGet, f.s.url+"/auth/google", nil)
	if err != nil {
		t.Fatal(err)
	}
	r.Host = "bad_host"
	res, err := http.DefaultClient.Do(r)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = res.Body.Close() }()
	body, _ := io.ReadAll(res.Body)
	expect(t, reply{res.StatusCode, string(body)}, http.StatusBadRequest, `{"detail":"Host no permitido"}`)
}

// Ported from the bootstrap tests of PR #211: it fills an empty link, keeps one an administrator
// set, reports a taken address, and concurrent cold starts never clobber each other.
func TestBootstrapGoogleAdminKeepsAnExistingLink(t *testing.T) {
	f := newAccountsFixture(t, "gboot")
	store := infrastructure.Store{DB: f.pool(t)}
	service := application.NewService(application.Deps{Store: store, Accounts: store, Google: store, Hasher: infrastructure.Passwords{}, Tokens: infrastructure.Tokens{}})
	admin := f.session(t, "admin", "admin", false)
	other := f.session(t, "other", "analista", false)

	email := func(user string) string {
		var out *string
		if err := f.conn.QueryRow(t.Context(), `SELECT google_email FROM users WHERE username = $1`, user).Scan(&out); err != nil {
			t.Fatal(err)
		}
		if out == nil {
			return ""
		}
		return *out
	}
	if err := service.BootstrapGoogleAdmin(t.Context(), " "+strings.ToUpper(admin)+" ", "Boot.Admin@Example.com"); err != nil {
		t.Fatal(err)
	}
	if email(admin) != "boot.admin@example.com" {
		t.Fatalf("linked %q", email(admin))
	}
	if err := service.BootstrapGoogleAdmin(t.Context(), admin, "otra@example.com"); err != nil {
		t.Fatal(err)
	}
	if email(admin) != "boot.admin@example.com" {
		t.Fatal("the bootstrap replaced an address")
	}
	if err := service.BootstrapGoogleAdmin(t.Context(), other, "gboot.nolink@example.com"); err != nil {
		t.Fatal(err)
	}
	if email(other) != "" {
		t.Fatal("the bootstrap linked an account that is not an administrator")
	}
	second := f.session(t, "second", "admin", false)
	if err := service.BootstrapGoogleAdmin(t.Context(), second, "boot.admin@example.com"); err != nil {
		t.Fatalf("a taken address only logs: %v", err)
	}
	if email(second) != "" {
		t.Fatal("two accounts share an address")
	}
	if err := service.BootstrapGoogleAdmin(t.Context(), second, "no-es-correo"); err == nil || err.Error() != "SIPGES_GOOGLE_ADMIN_EMAIL is not a valid address" {
		t.Fatalf("err = %v", err)
	}

	// Concurrent cold starts for two administrators and one address: one wins, neither fails.
	third := f.session(t, "third", "admin", false)
	var wg sync.WaitGroup
	errs := make(chan error, 8)
	for i := range 8 {
		user := second
		if i%2 == 1 {
			user = third
		}
		wg.Go(func() { errs <- service.BootstrapGoogleAdmin(context.Background(), user, "race@example.com") })
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatalf("a concurrent start failed: %v", err)
		}
	}
	if n := f.count(t, `SELECT count(*) FROM users WHERE google_email = 'race@example.com'`); n != 1 {
		t.Fatalf("%d accounts hold the address", n)
	}
}
