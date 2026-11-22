package app_test

import (
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/identity/infrastructure"
)

// The idle timeout of world-class-local T8f: a session ends after 60 minutes without user
// activity and still at most 8 hours after sign-in. Synthetic accounts and passwords only.

const (
	idleTTL          = time.Hour
	backgroundHeader = "X-SIPGES-Background"
)

// idleSession signs a synthetic account in through POST /login and returns its username and
// the clock's sign-in instant; tokens[user] holds the new session's token.
func (f *loginFixture) idleSession(t *testing.T) (string, time.Time) {
	t.Helper()
	user := f.account(t, "user", newHash(t), true, false)
	f.exec(t, `INSERT INTO grants (username, tenant_id) VALUES ($1, 'ACME/NORTE')`, user)
	signedIn := f.s.clock.now()
	got := f.login(t, user, loginPassword)
	match := loginCookie.FindStringSubmatch(got.header.Get("Set-Cookie"))
	if got.status != http.StatusOK || match == nil {
		t.Fatalf("login: %d %q", got.status, got.header.Values("Set-Cookie"))
	}
	tokens[user] = match[1]
	return user, signedIn
}

// expiresAt is the stored expiry of the user's request session.
func (f *loginFixture) expiresAt(t *testing.T, user string) time.Time {
	t.Helper()
	var at time.Time
	if err := f.conn.QueryRow(t.Context(), `SELECT expires_at FROM sessions WHERE token_hash = $1`,
		infrastructure.HashToken(tokens[user])).Scan(&at); err != nil {
		t.Fatal(err)
	}
	return at.UTC()
}

// activity is one authenticated request at the given offset from sign-in.
func (f *loginFixture) activity(t *testing.T, user string, at time.Time, headers map[string]string) reply {
	t.Helper()
	f.s.clock.set(at)
	return f.s.do(t, req{path: "/system/auth/sessions", user: user, headers: headers})
}

func expectExpiry(t *testing.T, got, want time.Time) {
	t.Helper()
	if !got.Equal(want) {
		t.Fatalf("expires_at = %s, want %s", got, want)
	}
}

func TestANewSessionExpiresAfterSixtyIdleMinutes(t *testing.T) {
	f := newLoginFixture(t, "idle-new")
	user, signedIn := f.idleSession(t)
	expectExpiry(t, f.expiresAt(t, user), signedIn.Add(idleTTL))
}

func TestActivityNearTheIdleLimitExtendsTheSession(t *testing.T) {
	f := newLoginFixture(t, "idle-slide")
	user, signedIn := f.idleSession(t)

	// Minute 2: 58 minutes remain, above the 55-minute write bound, so nothing is written.
	if got := f.activity(t, user, signedIn.Add(2*time.Minute), nil); got.status != http.StatusOK {
		t.Fatalf("minute 2: %d %s", got.status, got.body)
	}
	expectExpiry(t, f.expiresAt(t, user), signedIn.Add(idleTTL))

	// Minute 50: the session moves to 60 minutes from now, and the list shows the new expiry.
	minute50 := signedIn.Add(50 * time.Minute)
	got := f.activity(t, user, minute50, map[string]string{backgroundHeader: "0"})
	expectExpiry(t, f.expiresAt(t, user), minute50.Add(idleTTL))
	var body struct {
		Sessions []struct {
			ExpiresAt string `json:"expires_at"`
		} `json:"sessions"`
	}
	if err := json.Unmarshal([]byte(got.body), &body); err != nil || len(body.Sessions) != 1 {
		t.Fatalf("sessions: %d %s", got.status, got.body)
	}
	// The extension runs before the handler, so the list already reads it.
	if want := minute50.Add(idleTTL).UTC().Format("2006-01-02T15:04:05Z"); body.Sessions[0].ExpiresAt != want {
		t.Fatalf("listed expires_at = %s, want %s", body.Sessions[0].ExpiresAt, want)
	}

	// Minute 100 is past the sign-in hour but within the extended one.
	if got := f.activity(t, user, signedIn.Add(100*time.Minute), nil); got.status != http.StatusOK {
		t.Fatalf("minute 100: %d %s", got.status, got.body)
	}
}

func TestBackgroundRequestsDoNotExtendTheSession(t *testing.T) {
	f := newLoginFixture(t, "idle-bg")
	user, signedIn := f.idleSession(t)
	if got := f.activity(t, user, signedIn.Add(50*time.Minute), map[string]string{backgroundHeader: "1"}); got.status != http.StatusOK {
		t.Fatalf("background request: %d %s", got.status, got.body)
	}
	expectExpiry(t, f.expiresAt(t, user), signedIn.Add(idleTTL))
	// Polling alone lets the session lapse.
	expect(t, f.activity(t, user, signedIn.Add(idleTTL), map[string]string{backgroundHeader: "1"}), http.StatusUnauthorized, signIn)
}

func TestASessionIdlePastSixtyMinutesAnswers401(t *testing.T) {
	f := newLoginFixture(t, "idle-lapse")
	user, signedIn := f.idleSession(t)
	if got := f.activity(t, user, signedIn.Add(idleTTL-time.Millisecond), map[string]string{backgroundHeader: "1"}); got.status != http.StatusOK {
		t.Fatalf("before the limit: %d", got.status)
	}
	expect(t, f.activity(t, user, signedIn.Add(idleTTL+time.Minute), nil), http.StatusUnauthorized, signIn)
	// The lapsed request extended nothing.
	expectExpiry(t, f.expiresAt(t, user), signedIn.Add(idleTTL))
}

func TestAnActiveSessionStillEndsEightHoursAfterSignIn(t *testing.T) {
	f := newLoginFixture(t, "idle-cap")
	user, signedIn := f.idleSession(t)
	for at := 50 * time.Minute; at < sessionTTL; at += 50 * time.Minute {
		if got := f.activity(t, user, signedIn.Add(at), nil); got.status != http.StatusOK {
			t.Fatalf("minute %v: %d", at.Minutes(), got.status)
		}
	}
	expectExpiry(t, f.expiresAt(t, user), signedIn.Add(sessionTTL))
	if got := f.activity(t, user, signedIn.Add(sessionTTL-time.Millisecond), nil); got.status != http.StatusOK {
		t.Fatalf("just before the cap: %d", got.status)
	}
	expectExpiry(t, f.expiresAt(t, user), signedIn.Add(sessionTTL))
	expect(t, f.activity(t, user, signedIn.Add(sessionTTL), nil), http.StatusUnauthorized, signIn)
}

func TestProvidersAdvertiseTheIdleTimeout(t *testing.T) {
	s := start(t, false)
	got := s.do(t, req{path: "/system/auth/providers"})
	var body map[string]any
	if err := json.Unmarshal([]byte(got.body), &body); err != nil || got.status != http.StatusOK || body["idle_timeout_seconds"] != float64(3600) {
		t.Fatalf("providers: %d %s", got.status, got.body)
	}
}
