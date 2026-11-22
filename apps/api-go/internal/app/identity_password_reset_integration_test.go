package app_test

import (
	"encoding/json"
	"io"
	"net/http"
	"regexp"
	"strings"
	"testing"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/identity/infrastructure"
)

// POST /system/auth/accounts/{username}/password (world-class-local T8d): an administrator resets
// another person's forgotten password. Synthetic accounts and passwords only.

const (
	passwordReset = "PASSWORD_RESET"
	selfPassword  = `{"detail":"No puede restablecer su propia contraseña aquí; cámbiela con POST /system/auth/password"}`
)

// temporaryBody is the one answer of a reset: the password, once, and nothing else.
var temporaryBody = regexp.MustCompile(`^\{"temporary_password":"([ACDEFGHJKMNPQRSTUVWXYZ2345679]{20})"\}$`)

func resetPath(user string) string { return "/system/auth/accounts/" + user + "/password" }

// reset sends an administrator's reset of target and returns the reply with its headers.
func (f accountsFixture) reset(t *testing.T, target, admin string) (reply, http.Header) {
	t.Helper()
	r, err := http.NewRequestWithContext(t.Context(), http.MethodPost, f.s.url+resetPath(target), nil)
	if err != nil {
		t.Fatal(err)
	}
	r.Header.Set("Origin", f.s.url)
	r.Header.Set("X-SIPGES-Scope", f.project)
	r.Header.Set("Cookie", "sipges_session="+tokens[admin])
	res, err := http.DefaultClient.Do(r)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = res.Body.Close() }()
	body, _ := io.ReadAll(res.Body)
	return reply{res.StatusCode, string(body)}, res.Header
}

// resetTarget stores a granted account without MFA that signs in with loginPassword and has two
// open sessions besides the fixture's: it returns the username and the extra session tokens.
func (f accountsFixture) resetTarget(t *testing.T, suffix string) (string, []string) {
	t.Helper()
	user := f.session(t, suffix, "analista", true)
	f.exec(t, `UPDATE users SET password_hash = $2, totp_enabled = false, totp_secret_sealed = NULL WHERE username = $1`, user, newHash(t))
	others := []string{newToken(), newToken()}
	for _, token := range others {
		f.exec(t, `INSERT INTO sessions (token_hash, username, expires_at) VALUES ($1, $2, $3)`,
			infrastructure.HashToken(token), user, t0.Add(sessionTTL))
	}
	return user, others
}

func TestPasswordResetHandsOverATemporaryPasswordAndEndsEverySession(t *testing.T) {
	f := newAccountsFixture(t, "pwreset")
	admin := f.session(t, "admin", "admin", true)
	target, others := f.resetTarget(t, "target")
	bystander := f.session(t, "bystander", "analista", true)
	before := f.storedHash(t, target)

	got, header := f.reset(t, strings.ToUpper(target), admin)
	match := temporaryBody.FindStringSubmatch(strings.TrimSpace(got.body))
	if got.status != http.StatusOK || match == nil {
		t.Fatalf("got %d %s, want 200 and one temporary password", got.status, got.body)
	}
	temporary := match[1]
	if header.Get("Cache-Control") != "no-store" {
		t.Fatalf("Cache-Control = %q, want no-store", header.Get("Cache-Control"))
	}
	stored := f.storedHash(t, target)
	if stored == before || !strings.HasPrefix(stored, "$argon2id$v=19$m=19456,t=2,p=1$") || strings.Contains(stored, temporary) {
		t.Fatalf("stored = %q", stored)
	}
	// Every session of the target ends: the fixture's and the two others.
	if f.sessions(t, target) != 0 {
		t.Fatalf("%d sessions of the target survived", f.sessions(t, target))
	}
	for _, token := range others {
		if f.liveSession(t, token) {
			t.Fatal("another session of the target survived")
		}
	}
	// The administrator's own session and a bystander's stay.
	if f.sessions(t, admin) != 1 || f.sessions(t, bystander) != 1 {
		t.Fatal("a session of someone else ended")
	}
	expect(t, f.s.do(t, req{path: "/system/auth/me", user: admin}), http.StatusOK,
		`{"username":"`+admin+`","full_name":"Synthetic","role":"admin","active":1}`)

	// One audit row in the active project names both, and holds no password.
	if n := f.count(t, `SELECT count(*) FROM audit WHERE tenant_id = $1 AND module = 'Cuentas' AND record_id = $2
	      AND action = $3 AND detail = $4 AND ts = $5`, f.project, target, passwordReset,
		"Contraseña restablecida por "+admin+"; sesiones revocadas", f.s.clock.now()); n != 1 {
		t.Fatalf("%d audit rows, want 1", n)
	}
	if n := f.count(t, `SELECT count(*) FROM audit WHERE action = $1 AND record_id LIKE $2`, passwordReset, f.prefix+"-%"); n != 1 {
		t.Fatalf("%d reset audit rows of this test, want 1", n)
	}
	if n := f.count(t, `SELECT count(*) FROM audit WHERE position($1 in detail) > 0 OR position($1 in record_id) > 0`, temporary); n != 0 {
		t.Fatal("the temporary password reached the audit")
	}

	// Sign-in takes the temporary password and refuses the old one.
	expect(t, f.login(t, target, loginPassword).reply, http.StatusUnauthorized, badCredentials)
	f.exec(t, `DELETE FROM login_failures`)
	expect(t, f.login(t, target, temporary).reply, http.StatusOK, `{"ok":true,"name":"Synthetic","role":"analista"}`)

	// A second reset hands over a different password.
	again, _ := f.reset(t, target, admin)
	if m := temporaryBody.FindStringSubmatch(strings.TrimSpace(again.body)); m == nil || m[1] == temporary {
		t.Fatalf("second reset: %d %s", again.status, again.body)
	}
}

func TestPasswordResetIsForAdministratorsOnly(t *testing.T) {
	f := newAccountsFixture(t, "pwreset-role")
	target, others := f.resetTarget(t, "target")
	before := f.storedHash(t, target)
	for _, role := range []string{"analista", "coordinador", "consulta"} {
		actor := f.session(t, role, role, true)
		got, _ := f.reset(t, target, actor)
		expect(t, got, http.StatusForbidden, restricted)
	}
	if f.storedHash(t, target) != before || !f.liveSession(t, others[0]) {
		t.Fatal("a refused reset changed the account")
	}
}

func TestPasswordResetRefusesOneselfAndUnknownOrDeactivatedAccounts(t *testing.T) {
	f := newAccountsFixture(t, "pwreset-refuse")
	admin := f.session(t, "admin", "admin", true)
	gone, goneOthers := f.resetTarget(t, "gone")
	f.exec(t, `UPDATE users SET active = false WHERE username = $1`, gone)
	foreign := f.session(t, "foreign", "analista", false)
	adminHash, goneHash, foreignHash := f.storedHash(t, admin), f.storedHash(t, gone), f.storedHash(t, foreign)

	self, _ := f.reset(t, admin, admin)
	expect(t, self, http.StatusUnprocessableEntity, selfPassword)
	missing, _ := f.reset(t, "nobody-here", admin)
	expect(t, missing, http.StatusNotFound, noUser)
	deactivated, _ := f.reset(t, gone, admin)
	expect(t, deactivated, http.StatusNotFound, noUser)
	outside, _ := f.reset(t, foreign, admin)
	expect(t, outside, http.StatusForbidden, userOutOfScope)
	invalid, _ := f.reset(t, "%00", admin)
	expect(t, invalid, http.StatusUnprocessableEntity, badUser)

	if f.storedHash(t, admin) != adminHash || f.storedHash(t, gone) != goneHash || f.storedHash(t, foreign) != foreignHash {
		t.Fatal("a refused reset rewrote a hash")
	}
	if f.sessions(t, admin) != 1 || f.sessions(t, foreign) != 1 || !f.liveSession(t, goneOthers[0]) {
		t.Fatal("a refused reset ended a session")
	}
	if n := f.count(t, `SELECT count(*) FROM audit WHERE action = $1 AND record_id LIKE $2`, passwordReset, f.prefix+"-%"); n != 0 {
		t.Fatalf("%d audit rows for refused resets", n)
	}
}

func TestPasswordResetNeedsTheOriginCheckAndMFA(t *testing.T) {
	f := newAccountsFixture(t, "pwreset-guard")
	admin := f.session(t, "admin", "admin", true)
	target, _ := f.resetTarget(t, "target")
	before := f.storedHash(t, target)
	scope := map[string]string{"X-SIPGES-Scope": f.project}
	expect(t, f.s.do(t, req{method: http.MethodPost, path: resetPath(target), user: admin, headers: scope}),
		http.StatusForbidden, badOrigin)
	expect(t, f.s.do(t, req{method: http.MethodPost, path: resetPath(target), user: admin,
		headers: map[string]string{"X-SIPGES-Scope": f.project, "Origin": "https://evil.example"}}), http.StatusForbidden, badOrigin)
	expect(t, f.s.do(t, req{method: http.MethodPost, path: resetPath(target), sameOrigin: true, headers: scope}),
		http.StatusUnauthorized, signIn)

	// With SIPGES_REQUIRE_MFA, an administrator without a second factor is sent to enrol first.
	mfa := start(t, true)
	f.exec(t, `UPDATE users SET totp_enabled = false WHERE username = $1`, admin)
	expect(t, mfa.do(t, req{method: http.MethodPost, path: resetPath(target), user: admin, sameOrigin: true, headers: scope}),
		http.StatusForbidden, `{"detail":"Active la verificación en dos pasos (MFA) con /system/auth/totp/setup antes de continuar","mfa_required":true}`)
	if f.storedHash(t, target) != before {
		t.Fatal("a refused request rewrote the hash")
	}
}

// The capability flag tells clients the reset exists.
func TestProvidersAnnouncesThePasswordReset(t *testing.T) {
	s := start(t, false)
	got := s.do(t, req{path: "/system/auth/providers"})
	var body map[string]any
	if err := json.Unmarshal([]byte(got.body), &body); err != nil || got.status != http.StatusOK || body["password_reset"] != true {
		t.Fatalf("got %d %s", got.status, got.body)
	}
}

func TestPasswordResetLiftsTheLockoutOfThePersonOnly(t *testing.T) {
	f := newAccountsFixture(t, "pwreset-lockout")
	admin := f.session(t, "admin", "admin", true)
	target, _ := f.resetTarget(t, "target")
	f.exec(t, `DELETE FROM login_failures`)
	// The person used up the per-user limit; an address and someone else also hold failures.
	for range 5 {
		f.exec(t, `INSERT INTO login_failures (subject, failed_at) VALUES ($1, $2), ('ip:192.0.2.7', $2), ('user:someone-else', $2)`,
			"user:"+target, f.s.clock.now())
	}
	expect(t, f.login(t, target, loginPassword).reply, http.StatusTooManyRequests, tooManyLogins)

	// The administrator types the name as people do: the stored, normalised key still clears.
	got, _ := f.reset(t, strings.ToUpper(target), admin)
	match := temporaryBody.FindStringSubmatch(strings.TrimSpace(got.body))
	if got.status != http.StatusOK || match == nil {
		t.Fatalf("got %d %s, want 200 and one temporary password", got.status, got.body)
	}
	if n := f.count(t, `SELECT count(*) FROM login_failures WHERE subject = $1`, "user:"+target); n != 0 {
		t.Fatalf("%d failures of the person survived the reset", n)
	}
	if n := f.count(t, `SELECT count(*) FROM login_failures WHERE subject IN ('ip:192.0.2.7', 'user:someone-else')`); n != 10 {
		t.Fatalf("%d failures of others remain, want 10", n)
	}
	// The temporary password works at once, without waiting out the window.
	expect(t, f.login(t, target, match[1]).reply, http.StatusOK, `{"ok":true,"name":"Synthetic","role":"analista"}`)
}
