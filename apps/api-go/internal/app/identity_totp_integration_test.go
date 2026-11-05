package app_test

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/identity/infrastructure"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/secrets"
)

// Ported from apps/api/test/identity/auth-http.test.ts (enrolment, login with a second factor)
// and hardening.test.ts (replay, sealed secrets), plus the T35 probes. Every key is throwaway.

const (
	wrongTOTP       = `{"detail":"Código TOTP incorrecto"}`
	alreadyEnabled  = `{"detail":"MFA ya está activado; no se permite reiniciar la configuración"}`
	enrolled        = `{"ok":true,"totp_enabled":true}`
	totpInstruction = "Añada el código en una aplicación TOTP y confirme con /system/auth/totp/enable."
)

var (
	totpKey      = strings.Repeat("\x07", 32)
	totpPrevious = strings.Repeat("\x09", 32)
)

type totpFixture struct {
	*loginFixture
}

func newTOTPFixture(t *testing.T, prefix string) totpFixture {
	t.Helper()
	t.Setenv("SIPGES_DATA_KEY", base64.StdEncoding.EncodeToString([]byte(totpKey)))
	t.Setenv("SIPGES_DATA_KEY_PREVIOUS", base64.StdEncoding.EncodeToString([]byte(totpPrevious)))
	return totpFixture{newLoginFixture(t, prefix)}
}

func cipherFor(t *testing.T, key string) *secrets.Cipher {
	t.Helper()
	c, err := secrets.NewCipher([]byte(key))
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func seal(t *testing.T, key, plain string) string {
	t.Helper()
	sealed, err := cipherFor(t, key).Seal(plain)
	if err != nil {
		t.Fatal(err)
	}
	return sealed
}

// protected stores an account with MFA on, its secret sealed under the given key.
func (f totpFixture) protected(t *testing.T, suffix, sealed string) string {
	t.Helper()
	user := f.account(t, suffix, newHash(t), true, true)
	f.exec(t, `UPDATE users SET totp_secret_sealed = $2 WHERE username = $1`, user, sealed)
	return user
}

func (f totpFixture) code(t *testing.T, secret string, at time.Time) string {
	t.Helper()
	code, err := infrastructure.TOTP{}.CodeAt(secret, at)
	if err != nil {
		t.Fatal(err)
	}
	return code
}

func (f totpFixture) loginOTP(t *testing.T, user, otp string) loginReply {
	t.Helper()
	return f.post(t, url.Values{"username": {user}, "password": {loginPassword}, "otp": {otp}}, nil)
}

// session opens a session of an account without MFA, so it may enrol.
func (f totpFixture) session(t *testing.T, user string) {
	t.Helper()
	got := f.login(t, user, loginPassword)
	match := loginCookie.FindStringSubmatch(got.header.Get("Set-Cookie"))
	if match == nil {
		t.Fatalf("login: %d %s", got.status, got.body)
	}
	tokens[user] = match[1]
}

func (f totpFixture) setup(t *testing.T, user string) (reply, map[string]string) {
	t.Helper()
	got := f.s.do(t, req{method: "POST", path: "/system/auth/totp/setup", user: user, sameOrigin: true})
	var body map[string]string
	_ = json.Unmarshal([]byte(got.body), &body)
	return got, body
}

func (f totpFixture) enable(t *testing.T, user, body string) reply {
	t.Helper()
	return f.s.do(t, req{method: "POST", path: "/system/auth/totp/enable", user: user, sameOrigin: true,
		headers: map[string]string{"Content-Type": "application/json"}, body: body})
}

func TestTOTPEnrolmentSealsTheSecretAndKeepsOnlyTheCurrentSession(t *testing.T) {
	f := newTOTPFixture(t, "totp-enrol")
	user := f.account(t, "user", newHash(t), true, false)
	f.session(t, user)
	other := f.login(t, user, loginPassword)
	otherToken := loginCookie.FindStringSubmatch(other.header.Get("Set-Cookie"))[1]

	got, body := f.setup(t, user)
	if got.status != http.StatusOK || len(body["secret"]) != 32 || body["instruction"] != totpInstruction ||
		body["otpauth_uri"] != (infrastructure.TOTP{}).URI(user, body["secret"]) {
		t.Fatalf("setup: %d %s", got.status, got.body)
	}
	var sealed string
	if err := f.conn.QueryRow(t.Context(), `SELECT totp_secret_sealed FROM users WHERE username = $1`, user).Scan(&sealed); err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(sealed, "v1.") || strings.Contains(sealed, body["secret"]) {
		t.Fatalf("stored %q", sealed)
	}
	if opened, err := cipherFor(t, totpKey).Open(sealed); err != nil || opened != body["secret"] {
		t.Fatalf("opened %q, err %v", opened, err)
	}

	now := f.s.clock.now()
	right := f.code(t, body["secret"], now)
	wrong := "000000"
	if right == wrong {
		wrong = "111111"
	}
	expect(t, f.enable(t, user, `{"code":"`+wrong+`"}`), http.StatusUnprocessableEntity, wrongTOTP)
	expect(t, f.enable(t, user, `{"code":"`+right+`"}`), http.StatusOK, enrolled)

	if n := f.count(t, `SELECT count(*) FROM users WHERE username = $1 AND totp_enabled AND totp_last_step = $2`, user, now.UnixMilli()/30000); n != 1 {
		t.Fatal("enabling did not record the used step")
	}
	expect(t, f.s.do(t, req{path: "/system/auth/me", user: user}), http.StatusOK,
		`{"username":"`+user+`","full_name":"Synthetic Name","role":"analista","active":1}`)
	if n := f.count(t, `SELECT count(*) FROM sessions WHERE token_hash = $1`, infrastructure.HashToken(otherToken)); n != 0 {
		t.Fatal("another session survived enrolment")
	}
	// The enrolment code is spent, and a new setup cannot replace the factor.
	expect(t, f.loginOTP(t, user, right).reply, http.StatusUnauthorized, badOTP)
	got, _ = f.setup(t, user)
	expect(t, got, http.StatusConflict, alreadyEnabled)
}

func TestTOTPSetupAgainReplacesAPendingSecretAndForgetsItsStep(t *testing.T) {
	f := newTOTPFixture(t, "totp-pending")
	user := f.account(t, "user", newHash(t), true, false)
	f.session(t, user)
	f.exec(t, `UPDATE users SET totp_last_step = 5 WHERE username = $1`, user)
	_, first := f.setup(t, user)
	_, second := f.setup(t, user)
	if first["secret"] == second["secret"] {
		t.Fatal("setup repeated a secret")
	}
	if n := f.count(t, `SELECT count(*) FROM users WHERE username = $1 AND totp_last_step IS NULL`, user); n != 1 {
		t.Fatal("setup kept the last step")
	}
	expect(t, f.enable(t, user, `{"code":"`+f.code(t, first["secret"], f.s.clock.now())+`"}`), http.StatusUnprocessableEntity, wrongTOTP)
	expect(t, f.enable(t, user, `{"code":"`+f.code(t, second["secret"], f.s.clock.now())+`"}`), http.StatusOK, enrolled)
}

func TestTOTPEnableWithoutSetupIsAWrongCode(t *testing.T) {
	f := newTOTPFixture(t, "totp-nosetup")
	user := f.account(t, "user", newHash(t), true, false)
	f.session(t, user)
	expect(t, f.enable(t, user, `{"code":"123456"}`), http.StatusUnprocessableEntity, wrongTOTP)
}

func TestTOTPRequestGates(t *testing.T) {
	f := newTOTPFixture(t, "totp-gates")
	user := f.account(t, "user", newHash(t), true, false)
	f.session(t, user)
	issue := func(kind, msg string, loc ...string) string {
		return `{"detail":[{"type":"` + kind + `","loc":["` + strings.Join(append([]string{"body"}, loc...), `","`) + `"],"msg":"` + msg + `"}]}`
	}
	for body, want := range map[string]string{
		"":              issue("json_invalid", "JSON decode error"),
		"{":             issue("json_invalid", "JSON decode error"),
		"{}":            issue("missing", "Field required", "code"),
		`{"code":1}`:    issue("invalid_type", "Invalid input: expected string, received number", "code"),
		`{"code":null}`: issue("invalid_type", "Invalid input: expected string, received null", "code"),
		"[]":            issue("invalid_type", "Invalid input: expected object, received array"),
		"null":          issue("invalid_type", "Invalid input: expected object, received null"),
		`"x"`:           issue("invalid_type", "Invalid input: expected object, received string"),
	} {
		expect(t, f.enable(t, user, body), http.StatusUnprocessableEntity, want)
	}
	expect(t, f.s.do(t, req{method: "POST", path: "/system/auth/totp/setup"}), http.StatusUnauthorized, signIn)
	expect(t, f.s.do(t, req{method: "POST", path: "/system/auth/totp/enable", sameOrigin: true}), http.StatusUnauthorized, signIn)
	expect(t, f.s.do(t, req{method: "POST", path: "/system/auth/totp/setup", user: user}), http.StatusForbidden, badOrigin)
	expect(t, f.s.do(t, req{method: "GET", path: "/system/auth/totp/setup", user: user}), http.StatusNotFound, notFound)
}

func TestLoginAsksForTheSecondFactorAndRefusesReplays(t *testing.T) {
	f := newTOTPFixture(t, "totp-login")
	const secret = "JBSWY3DPEHPK3PXP"
	user := f.protected(t, "user", seal(t, totpKey, secret))
	now := f.s.clock.now()

	for _, otp := range []string{"", "12345", "abcdef"} {
		got := f.loginOTP(t, user, otp)
		expect(t, got.reply, http.StatusUnauthorized, badOTP)
		expectNoCookie(t, got)
	}
	f.exec(t, `DELETE FROM login_failures`)

	code := f.code(t, secret, now)
	got := f.loginOTP(t, user, code)
	if got.status != http.StatusOK || loginCookie.FindStringSubmatch(got.header.Get("Set-Cookie")) == nil {
		t.Fatalf("login: %d %s", got.status, got.body)
	}
	if n := f.count(t, `SELECT count(*) FROM users WHERE username = $1 AND totp_last_step = $2`, user, now.UnixMilli()/30000); n != 1 {
		t.Fatal("the used step was not stored")
	}
	// The same code, and the previous step's, are spent; the next step's is not.
	expect(t, f.loginOTP(t, user, code).reply, http.StatusUnauthorized, badOTP)
	expect(t, f.loginOTP(t, user, f.code(t, secret, now.Add(-30*time.Second))).reply, http.StatusUnauthorized, badOTP)
	if got := f.loginOTP(t, user, f.code(t, secret, now.Add(30*time.Second))); got.status != http.StatusOK {
		t.Fatalf("next step: %d %s", got.status, got.body)
	}
}

func TestLoginCountsAWrongSecondFactorTowardsTheThrottle(t *testing.T) {
	f := newTOTPFixture(t, "totp-throttle")
	user := f.protected(t, "user", seal(t, totpKey, "JBSWY3DPEHPK3PXP"))
	for range 5 {
		f.loginOTP(t, user, "abcdef")
	}
	expect(t, f.loginOTP(t, user, f.code(t, "JBSWY3DPEHPK3PXP", f.s.clock.now())).reply, http.StatusTooManyRequests, tooManyLogins)
}

func TestLoginOpensSecretsSealedBeforeARotation(t *testing.T) {
	f := newTOTPFixture(t, "totp-rotated")
	const secret = "JBSWY3DPEHPK3PXP"
	user := f.protected(t, "user", seal(t, totpPrevious, secret))
	if got := f.loginOTP(t, user, f.code(t, secret, f.s.clock.now())); got.status != http.StatusOK {
		t.Fatalf("got %d %s", got.status, got.body)
	}
}

func TestLoginFailsTheFactorNotTheRequestOnAnUnreadableSecret(t *testing.T) {
	f := newTOTPFixture(t, "totp-unreadable")
	const secret = "JBSWY3DPEHPK3PXP"
	code := f.code(t, secret, f.s.clock.now())
	for name, sealed := range map[string]string{
		"another key": seal(t, strings.Repeat("\x01", 32), secret),
		"corrupt":     "v1.AAAA",
		"not sealed":  secret,
	} {
		user := f.protected(t, strings.ReplaceAll(name, " ", "-"), sealed)
		expect(t, f.loginOTP(t, user, code).reply, http.StatusUnauthorized, badOTP)
	}
	user := f.account(t, "no-secret", newHash(t), true, true)
	expect(t, f.loginOTP(t, user, code).reply, http.StatusUnauthorized, badOTP)
}

func TestLoginAnswersLikeTypeScriptOnASecretThatIsNotBase32(t *testing.T) {
	f := newTOTPFixture(t, "totp-base32")
	user := f.protected(t, "user", seal(t, totpKey, "not base32!"))
	expect(t, f.loginOTP(t, user, "123456").reply, http.StatusInternalServerError, `{"detail":"Internal Server Error"}`)
}

func TestLoginWithoutADataKeyFailsTheFactorClosed(t *testing.T) {
	f := newLoginFixture(t, "totp-nokey")
	got := totpFixture{f}
	user := got.protected(t, "user", seal(t, totpKey, "JBSWY3DPEHPK3PXP"))
	expect(t, got.loginOTP(t, user, got.code(t, "JBSWY3DPEHPK3PXP", f.s.clock.now())).reply, http.StatusUnauthorized, badOTP)
	tokens[user] = newToken()
	expect(t, f.s.do(t, req{method: "POST", path: "/system/auth/totp/setup", sameOrigin: true}), http.StatusUnauthorized, signIn)
}
