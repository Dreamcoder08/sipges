package infrastructure_test

import (
	"slices"
	"testing"
	"time"
)

// Independent probes of EndOtherSessions (compact-sidebar T4, A1 and A2), mirroring
// apps/api/test/identity/sessions-verifier-probes.test.ts. Synthetic rows only.

// A session expiring exactly at `at` is expired, as ListSessions and the session lookup treat
// it; one millisecond later it is active.
func TestEndOtherSessionsExpiryBoundary(t *testing.T) {
	pool, store := sessionsDatabase(t)
	otherExpiry := time.Date(2026, 10, 12, 19, 1, 0, 0, time.UTC)

	count, err := store.EndOtherSessions(t.Context(), "admin", keepHash, otherExpiry, "SES/UNO", revokeAudit)
	if err != nil || count != 0 {
		t.Fatalf("at the expiry instant: count=%d err=%v", count, err)
	}
	if got := sessionHashes(t, pool); !slices.Equal(got, []string{keepHash, otherHash, expiredHash, anaHash}) {
		t.Fatalf("sessions = %v", got)
	}
	if n := auditRows(t, pool, "SES/UNO"); n != 0 {
		t.Fatalf("audit rows = %d", n)
	}
	listed, err := store.ListSessions(t.Context(), "admin", otherExpiry)
	if err != nil || len(listed) != 0 {
		t.Fatalf("listed at the expiry instant: %d err=%v", len(listed), err)
	}

	count, err = store.EndOtherSessions(t.Context(), "admin", keepHash, otherExpiry.Add(-time.Millisecond), "SES/UNO", revokeAudit)
	if err != nil || count != 1 {
		t.Fatalf("one millisecond before: count=%d err=%v", count, err)
	}
	if got := sessionHashes(t, pool); !slices.Equal(got, []string{keepHash, expiredHash, anaHash}) {
		t.Fatalf("sessions = %v", got)
	}
	if n := auditRows(t, pool, "SES/UNO"); n != 1 {
		t.Fatalf("audit rows = %d", n)
	}
}

// A skewed `at` never ends the kept session or another user's.
func TestEndOtherSessionsWithASkewedClockSparesTheKeptAndForeignRows(t *testing.T) {
	for _, tc := range []struct {
		name  string
		at    time.Time
		count int
		left  []string
		audit int
	}{
		{"a year behind", sessionsAt.AddDate(-1, 0, 0), 2, []string{keepHash, anaHash}, 1},
		{"a year ahead", sessionsAt.AddDate(1, 0, 0), 0, []string{keepHash, otherHash, expiredHash, anaHash}, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			pool, store := sessionsDatabase(t)
			count, err := store.EndOtherSessions(t.Context(), "admin", keepHash, tc.at, "SES/UNO", revokeAudit)
			if err != nil || count != tc.count {
				t.Fatalf("count=%d err=%v", count, err)
			}
			if got := sessionHashes(t, pool); !slices.Equal(got, tc.left) {
				t.Fatalf("sessions = %v", got)
			}
			if n := auditRows(t, pool, "SES/UNO"); n != tc.audit {
				t.Fatalf("audit rows = %d", n)
			}
		})
	}
}
