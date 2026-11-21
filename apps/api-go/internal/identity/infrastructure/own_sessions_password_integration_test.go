package infrastructure_test

import (
	"slices"
	"testing"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/identity/application"
)

func passwordAudit(int) application.SessionAudit {
	return application.SessionAudit{Action: "PASSWORD_CHANGE", RecordID: "admin", Detail: "x", At: sessionsAt}
}

// The kept session ended between the request's sign-in and the change (another change or a
// revoke won the race): nothing is written, so the losing change cannot set its password.
func TestReplacePasswordWithTheKeptSessionGoneWritesNothing(t *testing.T) {
	pool, store := sessionsDatabase(t)
	if _, err := pool.Exec(t.Context(), `DELETE FROM sessions WHERE token_hash = $1`, keepHash); err != nil {
		t.Fatal(err)
	}
	got, err := store.ReplacePassword(t.Context(), "admin", "synthetic-new-hash", keepHash, sessionsAt, "SES/UNO", passwordAudit)
	if err != nil || got != application.PasswordSessionGone {
		t.Fatalf("got %q, err %v", got, err)
	}
	var hash string
	if err := pool.QueryRow(t.Context(), `SELECT password_hash FROM users WHERE username = 'admin'`).Scan(&hash); err != nil || hash != "x" {
		t.Fatalf("hash = %q, err %v", hash, err)
	}
	if got := sessionHashes(t, pool); !slices.Equal(got, []string{otherHash, expiredHash, anaHash}) {
		t.Fatalf("sessions = %v", got)
	}
	var n int
	if err := pool.QueryRow(t.Context(), `SELECT count(*) FROM audit WHERE module = 'Cuentas'`).Scan(&n); err != nil || n != 0 {
		t.Fatalf("%d audit rows, err %v", n, err)
	}
}

// With the kept session there, the change goes through and only the other active one ends.
func TestReplacePasswordKeepsTheCurrentSession(t *testing.T) {
	pool, store := sessionsDatabase(t)
	got, err := store.ReplacePassword(t.Context(), "admin", "synthetic-new-hash", keepHash, sessionsAt, "SES/UNO", passwordAudit)
	if err != nil || got != application.PasswordReplaced {
		t.Fatalf("got %q, err %v", got, err)
	}
	if got := sessionHashes(t, pool); !slices.Equal(got, []string{keepHash, expiredHash, anaHash}) {
		t.Fatalf("sessions = %v", got)
	}
}
