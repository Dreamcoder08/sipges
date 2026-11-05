package app_test

import (
	"context"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/identity/infrastructure"
)

// Ported from apps/api/test/identity (login, throttle, rehash), plus the probes of T35: every
// refusal answers one of the generic bodies, and a session only ever comes from a success.

const (
	badCredentials = `{"detail":"Credenciales inválidas"}`
	badOTP         = `{"detail":"Código de autenticación inválido"}`
	tooManyLogins  = `{"detail":"Demasiados intentos fallidos; intente más tarde"}`
	loginPassword  = "synthetic-password-01"
)

// loginCookie is the exact Set-Cookie of setAuthCookie with SIPGES_COOKIE_SECURE unset.
var loginCookie = regexp.MustCompile(`^sipges_session=([0-9a-f]{64}); Max-Age=28800; Path=/; HttpOnly; Secure; SameSite=Strict$`)

// loginFixture holds one test's synthetic accounts; failures of earlier tests are forgotten.
type loginFixture struct {
	s      *server
	conn   *pgx.Conn
	prefix string
}

func newLoginFixture(t *testing.T, prefix string) *loginFixture {
	t.Helper()
	s := start(t, false)
	conn, err := pgx.Connect(t.Context(), scratch.URL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close(context.Background()) })
	f := &loginFixture{s: s, conn: conn, prefix: prefix}
	f.exec(t, `DELETE FROM login_failures`)
	return f
}

func (f *loginFixture) exec(t *testing.T, sql string, args ...any) {
	t.Helper()
	if _, err := f.conn.Exec(t.Context(), sql, args...); err != nil {
		t.Fatal(err)
	}
}

func (f *loginFixture) count(t *testing.T, sql string, args ...any) int {
	t.Helper()
	var n int
	if err := f.conn.QueryRow(t.Context(), sql, args...).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

// account stores a user whose hash TypeScript or Go wrote; it returns the username.
func (f *loginFixture) account(t *testing.T, suffix, hash string, active, totp bool) string {
	t.Helper()
	user := f.prefix + "-" + suffix
	f.exec(t, `INSERT INTO users (username, full_name, password_hash, role, active, totp_enabled) VALUES ($1, 'Synthetic Name', $2, 'analista', $3, $4)`,
		user, hash, active, totp)
	return user
}

func newHash(t *testing.T) string {
	t.Helper()
	hash, err := infrastructure.Passwords{}.Hash(loginPassword)
	if err != nil {
		t.Fatal(err)
	}
	return hash
}

type loginReply struct {
	reply
	header http.Header
}

func (f *loginFixture) post(t *testing.T, form url.Values, headers map[string]string) loginReply {
	t.Helper()
	r, err := http.NewRequestWithContext(t.Context(), http.MethodPost, f.s.url+"/login", strings.NewReader(form.Encode()))
	if err != nil {
		t.Fatal(err)
	}
	r.Header.Set("Origin", f.s.url)
	r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	for k, v := range headers {
		r.Header.Set(k, v)
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
	return loginReply{reply{res.StatusCode, body.String()}, res.Header}
}

func (f *loginFixture) login(t *testing.T, username, password string) loginReply {
	t.Helper()
	return f.post(t, url.Values{"username": {username}, "password": {password}}, nil)
}

func (f *loginFixture) sessions(t *testing.T, user string) int {
	t.Helper()
	return f.count(t, `SELECT count(*) FROM sessions WHERE username = $1`, user)
}

func expectNoCookie(t *testing.T, got loginReply) {
	t.Helper()
	if cookies := got.header.Values("Set-Cookie"); len(cookies) != 0 {
		t.Fatalf("a refused login set %q", cookies)
	}
}

func TestLoginOpensASessionOnlyTheTokenHashOfIsStored(t *testing.T) {
	f := newLoginFixture(t, "login-ok")
	user := f.account(t, "user", newHash(t), true, false)

	got := f.login(t, "  "+strings.ToUpper(user)+"\t", loginPassword)
	expect(t, got.reply, http.StatusOK, `{"ok":true,"name":"Synthetic Name","role":"analista"}`)
	match := loginCookie.FindStringSubmatch(got.header.Get("Set-Cookie"))
	if match == nil || len(got.header.Values("Set-Cookie")) != 1 {
		t.Fatalf("Set-Cookie = %q", got.header.Values("Set-Cookie"))
	}
	token := match[1]
	if n := f.count(t, `SELECT count(*) FROM sessions WHERE token_hash = $1 AND username = $2 AND NOT via_google
	      AND expires_at = $3 AND created_at = $4`,
		infrastructure.HashToken(token), user, f.s.clock.now().Add(sessionTTL), f.s.clock.now()); n != 1 {
		t.Fatal("the session row does not hold the token's hash, 8 h expiry and the clock's time")
	}
	if n := f.count(t, `SELECT count(*) FROM sessions WHERE token_hash = $1`, token); n != 0 {
		t.Fatal("the raw token was stored")
	}
	if n := f.count(t, `SELECT count(*) FROM login_failures`); n != 0 {
		t.Fatalf("a success left %d failures", n)
	}
	// The cookie opens the session.
	tokens[user] = token
	expect(t, f.s.do(t, req{path: "/system/auth/me", user: user}), http.StatusOK,
		`{"username":"`+user+`","full_name":"Synthetic Name","role":"analista","active":1}`)
}

func TestLoginRefusesEveryBadCaseWithTheSameGenericAnswer(t *testing.T) {
	f := newLoginFixture(t, "login-bad")
	hash := newHash(t)
	active := f.account(t, "active", hash, true, false)
	inactive := f.account(t, "inactive", hash, false, false)
	corrupt := f.account(t, "corrupt", "not-a-hash", true, false)
	for name, c := range map[string][2]string{
		"wrong password":        {active, loginPassword + "!"},
		"unknown user":          {f.prefix + "-nobody", loginPassword},
		"inactive account":      {inactive, loginPassword},
		"corrupt stored hash":   {corrupt, loginPassword},
		"empty password":        {active, ""},
		"NUL in the username":   {active + "\x00", loginPassword},
		"username over 120":     {strings.Repeat("a", 121), loginPassword},
		"empty username":        {"", loginPassword},
		"password hash as text": {active, hash},
	} {
		t.Run(name, func(t *testing.T) {
			f.exec(t, `DELETE FROM login_failures`)
			got := f.login(t, c[0], c[1])
			expect(t, got.reply, http.StatusUnauthorized, badCredentials)
			expectNoCookie(t, got)
			if n := f.count(t, `SELECT count(*) FROM login_failures`); n != 2 {
				t.Fatalf("%d failures recorded, want one per subject", n)
			}
		})
	}
	if n := f.sessions(t, active) + f.sessions(t, inactive) + f.sessions(t, corrupt); n != 0 {
		t.Fatalf("a refused login opened %d sessions", n)
	}
}

func TestLoginThrottlesAUserAfterFiveFailuresEvenWithTheRightPassword(t *testing.T) {
	f := newLoginFixture(t, "login-throttle")
	user := f.account(t, "user", newHash(t), true, false)
	for range 5 {
		expect(t, f.login(t, user, "wrong-password").reply, http.StatusUnauthorized, badCredentials)
	}
	for _, spelling := range []string{user, strings.ToUpper(user), " " + user + " "} {
		got := f.login(t, spelling, loginPassword)
		expect(t, got.reply, http.StatusTooManyRequests, tooManyLogins)
		if got.header.Get("Retry-After") != "900" {
			t.Fatalf("Retry-After = %q", got.header.Get("Retry-After"))
		}
		expectNoCookie(t, got)
	}
	if n := f.count(t, `SELECT count(*) FROM login_failures WHERE subject = $1`, "user:"+user); n != 5 {
		t.Fatalf("a throttled attempt was recorded: %d", n)
	}
	// One millisecond before the window ends it still holds; at its end the failures age out.
	base := f.s.clock.now()
	f.s.clock.set(base.Add(15*time.Minute - time.Millisecond))
	expect(t, f.login(t, user, loginPassword).reply, http.StatusTooManyRequests, tooManyLogins)
	f.s.clock.set(base.Add(15 * time.Minute))
	expect(t, f.login(t, user, loginPassword).reply, http.StatusOK, `{"ok":true,"name":"Synthetic Name","role":"analista"}`)
}

func TestLoginSuccessClearsTheUserFailuresButNotTheAddress(t *testing.T) {
	f := newLoginFixture(t, "login-clear")
	user := f.account(t, "user", newHash(t), true, false)
	for range 4 {
		f.login(t, user, "wrong-password")
	}
	if got := f.login(t, user, loginPassword); got.status != http.StatusOK {
		t.Fatalf("got %d", got.status)
	}
	if n := f.count(t, `SELECT count(*) FROM login_failures WHERE subject LIKE 'user:%'`); n != 0 {
		t.Fatalf("user failures left: %d", n)
	}
	if n := f.count(t, `SELECT count(*) FROM login_failures WHERE subject LIKE 'ip:%'`); n != 4 {
		t.Fatalf("address failures = %d, want the 4 failed attempts only", n)
	}
}

func TestLoginThrottlesAnAddressAcrossUsernames(t *testing.T) {
	f := newLoginFixture(t, "login-ip")
	user := f.account(t, "user", newHash(t), true, false)
	for i := range 20 {
		name := f.prefix + "-spray-" + string(rune('a'+i))
		expect(t, f.login(t, name, "wrong-password").reply, http.StatusUnauthorized, badCredentials)
	}
	expect(t, f.login(t, user, loginPassword).reply, http.StatusTooManyRequests, tooManyLogins)
}

func TestLoginKeysTheUserThrottleOnTheSanitizedName(t *testing.T) {
	f := newLoginFixture(t, "login-sanitized")
	name := strings.Repeat("b", 121)
	for range 5 {
		expect(t, f.login(t, name, "wrong-password").reply, http.StatusUnauthorized, badCredentials)
	}
	// The same first 120 characters share the bucket: longer names cannot dodge it.
	expect(t, f.login(t, name+"c", "wrong-password").reply, http.StatusTooManyRequests, tooManyLogins)
}

func TestLoginBurstsConsumeTheLimitInsteadOfReadingAStaleCount(t *testing.T) {
	f := newLoginFixture(t, "login-burst")
	user := f.account(t, "user", newHash(t), true, false)
	var wg sync.WaitGroup
	statuses := make(chan int, 12)
	for range 12 {
		wg.Go(func() { statuses <- f.login(t, user, "wrong-password").status })
	}
	wg.Wait()
	close(statuses)
	counts := map[int]int{}
	for s := range statuses {
		counts[s]++
	}
	if counts[http.StatusUnauthorized] != 5 || counts[http.StatusTooManyRequests] != 7 {
		t.Fatalf("statuses = %v", counts)
	}
}

func TestLoginReplacesALegacyHashAfterAFullSuccessOnly(t *testing.T) {
	f := newLoginFixture(t, "login-legacy")
	// app.py's format: PBKDF2-SHA256 of loginPassword, 1000 iterations, synthetic salt.
	const legacy = "pbkdf2_sha256$1000$030a11181f262d343b424950575e656c$d76781859f2175bf3830a4374cab3882016ad9d047502eee75c46446037530ee"
	user := f.account(t, "user", legacy, true, false)

	expect(t, f.login(t, user, "wrong-password").reply, http.StatusUnauthorized, badCredentials)
	if n := f.count(t, `SELECT count(*) FROM users WHERE username = $1 AND password_hash = $2`, user, legacy); n != 1 {
		t.Fatal("a failed login rewrote the hash")
	}
	if got := f.login(t, user, loginPassword); got.status != http.StatusOK {
		t.Fatalf("got %d %s", got.status, got.body)
	}
	var stored string
	if err := f.conn.QueryRow(t.Context(), `SELECT password_hash FROM users WHERE username = $1`, user).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(stored, "$argon2id$v=19$m=19456,t=2,p=1$") {
		t.Fatalf("stored = %q", stored)
	}
	if got := f.login(t, user, loginPassword); got.status != http.StatusOK {
		t.Fatalf("second login: %d %s", got.status, got.body)
	}
}

func TestLoginNeverSkipsTheSecondFactor(t *testing.T) {
	f := newLoginFixture(t, "login-totp")
	user := f.account(t, "user", newHash(t), true, true)
	for _, otp := range []string{"", "000000", "123456"} {
		got := f.post(t, url.Values{"username": {user}, "password": {loginPassword}, "otp": {otp}}, nil)
		expect(t, got.reply, http.StatusUnauthorized, badOTP)
		expectNoCookie(t, got)
	}
	if f.sessions(t, user) != 0 {
		t.Fatal("a session opened without the second factor")
	}
}

func TestLoginAlwaysMintsANewTokenSoASessionCannotBeFixed(t *testing.T) {
	f := newLoginFixture(t, "login-fixation")
	user := f.account(t, "user", newHash(t), true, false)
	planted := newToken()
	got := f.post(t, url.Values{"username": {user}, "password": {loginPassword}},
		map[string]string{"Cookie": "sipges_session=" + planted})
	match := loginCookie.FindStringSubmatch(got.header.Get("Set-Cookie"))
	if match == nil || match[1] == planted {
		t.Fatalf("Set-Cookie = %q", got.header.Get("Set-Cookie"))
	}
	if n := f.count(t, `SELECT count(*) FROM sessions WHERE token_hash = $1`, infrastructure.HashToken(planted)); n != 0 {
		t.Fatal("the planted token became a session")
	}
}

func TestLoginPurgesExpiredSessionsOnSuccess(t *testing.T) {
	f := newLoginFixture(t, "login-purge")
	user := f.account(t, "user", newHash(t), true, false)
	stale := infrastructure.HashToken(newToken())
	f.exec(t, `INSERT INTO sessions (token_hash, username, expires_at) VALUES ($1, $2, $3)`, stale, user, f.s.clock.now())
	if got := f.login(t, user, loginPassword); got.status != http.StatusOK {
		t.Fatalf("got %d", got.status)
	}
	if n := f.count(t, `SELECT count(*) FROM sessions WHERE token_hash = $1`, stale); n != 0 {
		t.Fatal("an expired session survived")
	}
}

func TestLoginRequestGates(t *testing.T) {
	f := newLoginFixture(t, "login-gates")
	s := f.s
	form := map[string]string{"Content-Type": "application/x-www-form-urlencoded"}
	missing := func(names ...string) string {
		var issues []string
		for _, n := range names {
			issues = append(issues, `{"type":"missing","loc":["body","`+n+`"],"msg":"Field required"}`)
		}
		return `{"detail":[` + strings.Join(issues, ",") + `]}`
	}
	expect(t, s.do(t, req{method: "POST", path: "/login", headers: form, body: "username=a&password=b"}), http.StatusForbidden, badOrigin)
	expect(t, s.do(t, req{method: "POST", path: "/login", sameOrigin: true}), http.StatusUnprocessableEntity, missing("username", "password"))
	expect(t, s.do(t, req{method: "POST", path: "/login", sameOrigin: true, headers: form, body: "username=a"}), http.StatusUnprocessableEntity, missing("password"))
	expect(t, s.do(t, req{method: "POST", path: "/login", sameOrigin: true, headers: map[string]string{"Content-Type": "application/json"}, body: `{"username":"a","password":"b"}`}),
		http.StatusUnprocessableEntity, missing("username", "password"))
	expect(t, s.do(t, req{method: "POST", path: "/login", sameOrigin: true, headers: map[string]string{"Content-Type": "multipart/form-data"}, body: "x"}),
		http.StatusUnprocessableEntity, `{"detail":[{"type":"value_error","loc":["body"],"msg":"Invalid form body"}]}`)
	expect(t, s.do(t, req{method: "GET", path: "/login"}), http.StatusNotFound, notFound)
	// Bodies past the limit are refused before any check.
	expect(t, s.do(t, req{method: "POST", path: "/login", sameOrigin: true, headers: form, body: "username=a&password=" + strings.Repeat("x", 1<<20)}),
		http.StatusUnprocessableEntity, `{"detail":[{"type":"value_error","loc":["body"],"msg":"Invalid form body"}]}`)
	if n := f.count(t, `SELECT count(*) FROM login_failures`); n != 0 {
		t.Fatalf("a refused request reached the throttle: %d", n)
	}
}
