package infrastructure_test

import (
	"context"
	"os"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/identity/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/identity/infrastructure"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/database/dbtest"
)

// The own-session writes of Cuenta against PostgreSQL, as sessions-hardening.test.ts proves
// them for sql-identity-store.ts. Synthetic accounts and tokens only.

var sessionsAt = time.Date(2026, 10, 12, 12, 0, 0, 0, time.UTC)

// Synthetic stored hashes (64 hex characters, as the table requires), in sort order.
var (
	keepHash    = strings.Repeat("1", 64)
	otherHash   = strings.Repeat("2", 64)
	expiredHash = strings.Repeat("3", 64)
	anaHash     = strings.Repeat("4", 64)
	goneHash    = strings.Repeat("5", 64)
)

// sessionsDatabase holds two projects, the administrator's kept, other and expired sessions,
// and another user's session.
func sessionsDatabase(t *testing.T) (*pgxpool.Pool, infrastructure.Store) {
	t.Helper()
	adminURL := os.Getenv(dbtest.EnvAdminURL)
	if adminURL == "" {
		t.Skip(dbtest.EnvAdminURL + " is not set")
	}
	s, err := dbtest.NewScratch(t.Context(), adminURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Drop(context.Background()) })
	pool, err := pgxpool.New(t.Context(), s.URL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	if _, err := pool.Exec(t.Context(), strings.NewReplacer(
		"KEEP", keepHash, "OTHER", otherHash, "EXPIRED", expiredHash, "ANA", anaHash).Replace(`
		INSERT INTO tenants (company_id, project_id, label) VALUES ('SES', 'UNO', 'Uno'), ('SES', 'DOS', 'Dos');
		INSERT INTO users (username, full_name, password_hash, role, active) VALUES
		  ('admin', 'Admin Sintético', 'x', 'admin', true),
		  ('ana', 'Ana Sintética', 'x', 'analista', true);
		INSERT INTO sessions (token_hash, username, created_at, expires_at, via_google) VALUES
		  ('KEEP', 'admin', '2026-10-12T11:00:00Z', '2026-10-12T19:00:00Z', false),
		  ('OTHER', 'admin', '2026-10-12T11:01:00Z', '2026-10-12T19:01:00Z', false),
		  ('EXPIRED', 'admin', '2026-10-11T11:00:00Z', '2026-10-11T19:00:00Z', false),
		  ('ANA', 'ana', '2026-10-12T11:02:00Z', '2026-10-12T19:02:00Z', false);`)); err != nil {
		t.Fatal(err)
	}
	return pool, infrastructure.Store{DB: pool}
}

func revokeAudit(int) application.SessionAudit {
	return application.SessionAudit{Action: "SESSIONS_END_OTHERS", RecordID: "admin", Detail: "x", At: sessionsAt}
}

func sessionHashes(t *testing.T, pool *pgxpool.Pool) []string {
	t.Helper()
	rows, err := pool.Query(t.Context(), `SELECT token_hash FROM sessions ORDER BY token_hash`)
	if err != nil {
		t.Fatal(err)
	}
	var out []string
	for rows.Next() {
		var hash string
		if err := rows.Scan(&hash); err != nil {
			t.Fatal(err)
		}
		out = append(out, hash)
	}
	return out
}

func auditRows(t *testing.T, pool *pgxpool.Pool, tenantID string) int {
	t.Helper()
	var n int
	if err := pool.QueryRow(t.Context(),
		`SELECT count(*) FROM audit WHERE module = 'Sesiones' AND tenant_id = $1`, tenantID).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

// A2 and A1: only active sessions end and count; ending none writes no audit row.
func TestEndOtherSessionsEndsOnlyActiveOnesAndNeverAuditsZero(t *testing.T) {
	pool, store := sessionsDatabase(t)
	count, err := store.EndOtherSessions(t.Context(), "admin", keepHash, sessionsAt, "SES/UNO", revokeAudit)
	if err != nil || count != 1 {
		t.Fatalf("count=%d err=%v", count, err)
	}
	if got := sessionHashes(t, pool); !slices.Equal(got, []string{keepHash, expiredHash, anaHash}) {
		t.Fatalf("sessions = %v", got)
	}
	count, err = store.EndOtherSessions(t.Context(), "admin", keepHash, sessionsAt, "SES/UNO", revokeAudit)
	if err != nil || count != 0 {
		t.Fatalf("again: count=%d err=%v", count, err)
	}
	if uno, dos := auditRows(t, pool, "SES/UNO"), auditRows(t, pool, "SES/DOS"); uno != 1 || dos != 0 {
		t.Fatalf("audit rows: SES/UNO=%d SES/DOS=%d", uno, dos)
	}
}

func TestEndOtherSessionsWithTheKeptRowGoneEndsOnlyThatUsers(t *testing.T) {
	pool, store := sessionsDatabase(t)
	count, err := store.EndOtherSessions(t.Context(), "admin", goneHash, sessionsAt, "SES/UNO", revokeAudit)
	if err != nil || count != 2 {
		t.Fatalf("count=%d err=%v", count, err)
	}
	if got := sessionHashes(t, pool); !slices.Equal(got, []string{expiredHash, anaHash}) {
		t.Fatalf("sessions = %v", got)
	}
}

func TestEndSessionAuditsOnlyInTheChosenProject(t *testing.T) {
	pool, store := sessionsDatabase(t)
	ended, err := store.EndSession(t.Context(), "admin", otherHash, "SES/DOS",
		application.SessionAudit{Action: "SESSION_END", RecordID: "admin", Detail: "x", At: sessionsAt})
	if err != nil || !ended {
		t.Fatalf("ended=%v err=%v", ended, err)
	}
	// Another user's session is not the caller's to end, and leaves no audit row.
	ended, err = store.EndSession(t.Context(), "admin", anaHash, "SES/DOS",
		application.SessionAudit{Action: "SESSION_END", RecordID: "admin", Detail: "x", At: sessionsAt})
	if err != nil || ended {
		t.Fatalf("foreign: ended=%v err=%v", ended, err)
	}
	if uno, dos := auditRows(t, pool, "SES/UNO"), auditRows(t, pool, "SES/DOS"); uno != 0 || dos != 1 {
		t.Fatalf("audit rows: SES/UNO=%d SES/DOS=%d", uno, dos)
	}
}

func TestSessionWritesRollBackWhenTheAuditRowFails(t *testing.T) {
	pool, store := sessionsDatabase(t)
	if _, err := pool.Exec(t.Context(), `
		CREATE FUNCTION refuse_audit() RETURNS trigger LANGUAGE plpgsql AS $$
		  BEGIN RAISE EXCEPTION 'synthetic audit failure'; END $$;
		CREATE TRIGGER refuse_audit BEFORE INSERT ON audit FOR EACH ROW EXECUTE FUNCTION refuse_audit();`); err != nil {
		t.Fatal(err)
	}
	before := sessionHashes(t, pool)
	if _, err := store.EndSession(t.Context(), "admin", otherHash, "SES/UNO",
		application.SessionAudit{Action: "SESSION_END", RecordID: "admin", Detail: "x", At: sessionsAt}); err == nil {
		t.Fatal("EndSession: want the audit error")
	}
	if _, err := store.EndOtherSessions(t.Context(), "admin", keepHash, sessionsAt, "SES/UNO", revokeAudit); err == nil {
		t.Fatal("EndOtherSessions: want the audit error")
	}
	if got := sessionHashes(t, pool); !slices.Equal(got, before) {
		t.Fatalf("sessions = %v, want %v", got, before)
	}
}
