package app_test

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/identity/infrastructure"
)

// POST /system/auth/password (world-class-local T8a): a signed-in person changes their own
// password. Synthetic accounts and passwords only.

const (
	passwordPath    = "/system/auth/password"
	newPassword     = "synthetic-changed-02"
	passwordChanged = "PASSWORD_CHANGE"
)

// passwordAccount stores an account granted ACME/NORTE with two open sessions: tokens[user] is
// the one the requests use, other is a second device.
func (f *loginFixture) passwordAccount(t *testing.T, suffix string) (user, other string) {
	t.Helper()
	user = f.account(t, suffix, newHash(t), true, false)
	f.exec(t, `INSERT INTO grants (username, tenant_id) VALUES ($1, 'ACME/NORTE')`, user)
	tokens[user], other = newToken(), newToken()
	for _, token := range []string{tokens[user], other} {
		f.exec(t, `INSERT INTO sessions (token_hash, username, expires_at) VALUES ($1, $2, $3)`,
			infrastructure.HashToken(token), user, f.s.clock.now().Add(sessionTTL))
	}
	return user, other
}

func passwordBody(t *testing.T, current, next string) string {
	t.Helper()
	body, err := json.Marshal(map[string]string{"current_password": current, "new_password": next})
	if err != nil {
		t.Fatal(err)
	}
	return string(body)
}

func (f *loginFixture) changePassword(t *testing.T, user, current, next string) reply {
	t.Helper()
	return f.s.do(t, req{method: http.MethodPost, path: passwordPath, user: user, sameOrigin: true,
		headers: map[string]string{"Content-Type": "application/json"}, body: passwordBody(t, current, next)})
}

func (f *loginFixture) storedHash(t *testing.T, user string) string {
	t.Helper()
	var hash string
	if err := f.conn.QueryRow(t.Context(), `SELECT password_hash FROM users WHERE username = $1`, user).Scan(&hash); err != nil {
		t.Fatal(err)
	}
	return hash
}

func (f *loginFixture) liveSession(t *testing.T, token string) bool {
	t.Helper()
	return f.count(t, `SELECT count(*) FROM sessions WHERE token_hash = $1`, infrastructure.HashToken(token)) == 1
}

func TestPasswordChangeRefusesAWrongCurrentPasswordAndCountsTheAttempt(t *testing.T) {
	f := newLoginFixture(t, "pw-wrong")
	user, other := f.passwordAccount(t, "user")
	before := f.storedHash(t, user)

	expect(t, f.changePassword(t, user, "wrong-password", newPassword), http.StatusBadRequest, badCredentials)
	if f.storedHash(t, user) != before {
		t.Fatal("a refused change rewrote the hash")
	}
	if n := f.count(t, `SELECT count(*) FROM login_failures WHERE subject = $1`, "user:"+user); n != 1 {
		t.Fatalf("%d failures of the user, want 1", n)
	}
	if n := f.count(t, `SELECT count(*) FROM login_failures WHERE subject LIKE 'ip:%'`); n != 1 {
		t.Fatalf("%d failures of the address, want 1", n)
	}
	if !f.liveSession(t, other) {
		t.Fatal("a refused change ended another session")
	}
}

func TestPasswordChangeSharesTheLoginThrottle(t *testing.T) {
	f := newLoginFixture(t, "pw-throttle")
	user, _ := f.passwordAccount(t, "user")
	for range 3 {
		expect(t, f.changePassword(t, user, "wrong-password", newPassword), http.StatusBadRequest, badCredentials)
	}
	// Failed sign-ins and failed changes fill the same bucket.
	for range 2 {
		expect(t, f.login(t, user, "wrong-password").reply, http.StatusUnauthorized, badCredentials)
	}
	before := f.storedHash(t, user)
	expect(t, f.changePassword(t, user, loginPassword, newPassword), http.StatusTooManyRequests, tooManyLogins)
	if f.storedHash(t, user) != before {
		t.Fatal("a throttled change rewrote the hash")
	}
	expect(t, f.login(t, user, loginPassword).reply, http.StatusTooManyRequests, tooManyLogins)
}

func TestPasswordChangeRefusesAWeakNewPasswordWithItsReason(t *testing.T) {
	f := newLoginFixture(t, "pw-policy")
	user, other := f.passwordAccount(t, "user")
	before := f.storedHash(t, user)
	for name, c := range map[string][2]string{
		"too short":       {"synthetic-1", `{"detail":"Contraseña demasiado corta: mínimo 12 caracteres"}`},
		"too long":        {strings.Repeat("z", 129), `{"detail":"Contraseña demasiado larga: máximo 128 caracteres"}`},
		"the username":    {strings.ToUpper(user), `{"detail":"La contraseña no puede ser igual al nombre de usuario"}`},
		"the current one": {loginPassword, `{"detail":"La nueva contraseña debe ser distinta de la actual"}`},
		"a common one":    {"Qwerty123456", `{"detail":"La contraseña es demasiado común; elija otra"}`},
	} {
		t.Run(name, func(t *testing.T) {
			expect(t, f.changePassword(t, user, loginPassword, c[0]), http.StatusUnprocessableEntity, c[1])
		})
	}
	if f.storedHash(t, user) != before || !f.liveSession(t, other) {
		t.Fatal("a refused change rewrote the hash or ended a session")
	}
	// The current password was right each time, so nothing counts toward the throttle.
	if n := f.count(t, `SELECT count(*) FROM login_failures`); n != 0 {
		t.Fatalf("%d failures recorded for a right current password", n)
	}
}

func TestPasswordChangeKeepsThisSessionAndEndsTheOthers(t *testing.T) {
	f := newLoginFixture(t, "pw-ok")
	user, other := f.passwordAccount(t, "user")
	// Every role may change its own password, read-only included.
	f.exec(t, `UPDATE users SET role = 'consulta' WHERE username = $1`, user)
	bystander, bystanderOther := f.passwordAccount(t, "bystander")
	f.exec(t, `DELETE FROM audit WHERE action = $1`, passwordChanged)

	got := f.changePassword(t, user, loginPassword, newPassword)
	if got.status != http.StatusNoContent || got.body != "" {
		t.Fatalf("got %d %q, want 204 and no body", got.status, got.body)
	}
	if !strings.HasPrefix(f.storedHash(t, user), "$argon2id$v=19$m=19456,t=2,p=1$") {
		t.Fatalf("stored = %q", f.storedHash(t, user))
	}
	if !f.liveSession(t, tokens[user]) || f.liveSession(t, other) {
		t.Fatal("want this session kept and the other one ended")
	}
	if !f.liveSession(t, tokens[bystander]) || !f.liveSession(t, bystanderOther) {
		t.Fatal("another person's sessions ended")
	}
	expect(t, f.s.do(t, req{path: "/system/auth/me", user: user}), http.StatusOK,
		`{"username":"`+user+`","full_name":"Synthetic Name","role":"consulta","active":1}`)
	if n := f.count(t, `SELECT count(*) FROM audit WHERE tenant_id = 'ACME/NORTE' AND module = 'Cuentas'
	      AND action = $1 AND record_id = $2 AND detail = $3`, passwordChanged, user,
		"Contraseña cambiada por "+user+"; 1 sesión cerrada en otros dispositivos"); n != 1 {
		t.Fatalf("%d audit rows, want 1", n)
	}

	// Sign-in follows the new password and refuses the old one.
	expect(t, f.login(t, user, loginPassword).reply, http.StatusUnauthorized, badCredentials)
	f.exec(t, `DELETE FROM login_failures`)
	expect(t, f.login(t, user, newPassword).reply, http.StatusOK, `{"ok":true,"name":"Synthetic Name","role":"consulta"}`)
}

func TestPasswordChangeNeedsTheOriginCheckAndASession(t *testing.T) {
	f := newLoginFixture(t, "pw-guard")
	user, _ := f.passwordAccount(t, "user")
	before := f.storedHash(t, user)
	body := passwordBody(t, loginPassword, newPassword)
	jsonType := map[string]string{"Content-Type": "application/json"}
	expect(t, f.s.do(t, req{method: http.MethodPost, path: passwordPath, user: user, headers: jsonType, body: body}),
		http.StatusForbidden, badOrigin)
	expect(t, f.s.do(t, req{method: http.MethodPost, path: passwordPath, user: user, body: body,
		headers: map[string]string{"Content-Type": "application/json", "Origin": "https://evil.example"}}),
		http.StatusForbidden, badOrigin)
	expect(t, f.s.do(t, req{method: http.MethodPost, path: passwordPath, sameOrigin: true, headers: jsonType, body: body}),
		http.StatusUnauthorized, signIn)
	if f.storedHash(t, user) != before {
		t.Fatal("a refused request rewrote the hash")
	}
	expect(t, f.s.do(t, req{method: http.MethodPost, path: passwordPath, user: user, sameOrigin: true, headers: jsonType,
		body: `{"current_password":"x"}`}), http.StatusUnprocessableEntity,
		`{"detail":[{"type":"missing","loc":["body","new_password"],"msg":"Field required"}]}`)
}

// The web asks whether this API offers the change by posting an empty body (world-class-local T8c):
// it must answer 422 before reading credentials, so the probe never fills the login throttle.
func TestAnEmptyPasswordChangeIsRefusedBeforeTheThrottle(t *testing.T) {
	f := newLoginFixture(t, "pw-probe")
	user, _ := f.passwordAccount(t, "user")
	jsonType := map[string]string{"Content-Type": "application/json"}
	for range 8 { // beyond the five failures that throttle a sign-in
		got := f.s.do(t, req{method: http.MethodPost, path: passwordPath, user: user, sameOrigin: true, headers: jsonType, body: `{}`})
		if got.status != http.StatusUnprocessableEntity {
			t.Fatalf("empty body answered %d %s, want 422", got.status, got.body)
		}
	}
	expect(t, f.changePassword(t, user, loginPassword, newPassword), http.StatusNoContent, "")
}
