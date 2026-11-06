package http_test

import (
	"bufio"
	"context"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	audithttp "github.com/Dreamcoder08/sipges/apps/api-go/internal/audit/http"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/identity/domain"
	identityhttp "github.com/Dreamcoder08/sipges/apps/api-go/internal/identity/http"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/identity/infrastructure"
	tenancydomain "github.com/Dreamcoder08/sipges/apps/api-go/internal/tenancy/domain"
	tenancyhttp "github.com/Dreamcoder08/sipges/apps/api-go/internal/tenancy/http"
)

// An open stream keeps its access only while that access lasts: module and action names must
// stop within a poll of a logout, an expired session, a deactivated account or a revoked grant.
// Twin of apps/api/test/platform/activity-access.test.ts. The routes run with a short poll
// behind the context the gates would leave, because the composition keeps the default of 10 s.

const accessPoll = 20 * time.Millisecond

type accessStream struct {
	lines chan string
	ended chan struct{}
	seen  []string
}

func openAccessStream(t *testing.T, user string, scope tenancydomain.Scope) *accessStream {
	t.Helper()
	if scratch == nil {
		t.Skip("no database")
	}
	pool, err := pgxpool.New(t.Context(), scratch.URL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	mux := http.NewServeMux()
	audithttp.Register(mux, audithttp.Deps{
		Pool: pool, Logger: slog.New(slog.DiscardHandler), Now: func() time.Time { return t0 },
		ActivityPoll: accessPoll, ActivityMax: 1500 * time.Millisecond,
	})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx := identityhttp.WithPrincipal(tenancyhttp.WithScope(r.Context(), scope), &domain.Principal{Username: user, Role: "analista"})
		mux.ServeHTTP(w, r.WithContext(ctx))
	}))
	t.Cleanup(srv.Close)

	r, err := http.NewRequestWithContext(t.Context(), http.MethodGet, srv.URL+audithttp.ActivityPath, nil)
	if err != nil {
		t.Fatal(err)
	}
	r.Header.Set("Cookie", "sipges_session="+tokens[user])
	res, err := http.DefaultClient.Do(r)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = res.Body.Close() })
	s := &accessStream{lines: make(chan string, 64), ended: make(chan struct{})}
	go func() {
		defer close(s.ended)
		sc := bufio.NewScanner(res.Body)
		for sc.Scan() {
			s.lines <- sc.Text()
		}
	}()
	return s
}

// activity drains what arrived within a few polls and counts the activity events seen so far.
func (s *accessStream) activity() int {
	timer := time.After(accessPoll * 6)
	for {
		select {
		case line := <-s.lines:
			s.seen = append(s.seen, line)
		case <-timer:
			return strings.Count(strings.Join(s.seen, "\n"), "event: activity")
		}
	}
}

func (s *accessStream) endsWithin(d time.Duration) bool {
	timer := time.After(d)
	for {
		select {
		case line := <-s.lines:
			s.seen = append(s.seen, line)
		case <-s.ended:
			return true
		case <-timer:
			return false
		}
	}
}

// listener adds a synthetic account with a session and the given projects.
func listener(t *testing.T, conn *pgx.Conn, user string, projects ...string) {
	t.Helper()
	exec(t, conn, `INSERT INTO users (username, full_name, password_hash, role, active, totp_enabled) VALUES ($1, 'Oyente', 'x', 'analista', true, true)`, user)
	tokens[user] = strings.Repeat("ab", 28) + infrastructure.HashToken(user)[:8]
	exec(t, conn, `INSERT INTO sessions (token_hash, username, expires_at) VALUES ($1, $2, $3)`,
		infrastructure.HashToken(tokens[user]), user, t0.Add(8*time.Hour))
	for _, p := range projects {
		exec(t, conn, `INSERT INTO grants (username, tenant_id) VALUES ($1, $2)`, user, p)
	}
}

func exec(t *testing.T, conn *pgx.Conn, sql string, args ...any) {
	t.Helper()
	if _, err := conn.Exec(context.WithoutCancel(t.Context()), sql, args...); err != nil {
		t.Fatal(err)
	}
}

func writeEntry(t *testing.T, conn *pgx.Conn, tenantID string) {
	t.Helper()
	exec(t, conn, `INSERT INTO audit (tenant_id, ts, module, action) VALUES ($1, now(), 'Demandas', 'CREATE')`, tenantID)
}

func accessConn(t *testing.T) *pgx.Conn {
	t.Helper()
	if scratch == nil {
		t.Skip("no database")
	}
	conn, err := pgx.Connect(t.Context(), scratch.URL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close(context.Background()) })
	return conn
}

// north is a project of these tests alone: the other tests of this package count the shared
// trail, and exact ids.
var north = tenancydomain.Scope{CompanyID: "ACCESO", ProjectID: "UNO"}

func accessProject(t *testing.T, conn *pgx.Conn) {
	t.Helper()
	exec(t, conn, `INSERT INTO tenants (company_id, project_id, label) VALUES ('ACCESO', 'UNO', 'Uno') ON CONFLICT DO NOTHING`)
}

func TestActivityStreamEndsWhenItsAccessEnds(t *testing.T) {
	for name, end := range map[string]string{
		"logout":              `DELETE FROM sessions WHERE username = $1`,
		"expired session":     `UPDATE sessions SET expires_at = '2000-01-01' WHERE username = $1`,
		"deactivated account": `UPDATE users SET active = false WHERE username = $1`,
		"revoked grant":       `DELETE FROM grants WHERE username = $1`,
	} {
		t.Run(name, func(t *testing.T) {
			conn := accessConn(t)
			accessProject(t, conn)
			user := "oyente-" + strings.ReplaceAll(name, " ", "-")
			listener(t, conn, user, north.TenantID())
			stream := openAccessStream(t, user, north)
			stream.activity()
			writeEntry(t, conn, north.TenantID())
			if n := stream.activity(); n != 1 {
				t.Fatalf("%d events before access ended", n)
			}
			exec(t, conn, end, user)
			stream.activity()
			writeEntry(t, conn, north.TenantID())
			if !stream.endsWithin(time.Second) {
				t.Fatal("the stream outlived its access")
			}
			if n := stream.activity(); n != 1 {
				t.Fatalf("%d events after access ended", n)
			}
		})
	}
}

func TestActivityStreamOutlivesTheLossOfAnotherProject(t *testing.T) {
	conn := accessConn(t)
	accessProject(t, conn)
	listener(t, conn, "oyente-dos", north.TenantID(), "SIPGES/PRJ-SECHURA")
	stream := openAccessStream(t, "oyente-dos", north)
	stream.activity()
	exec(t, conn, `DELETE FROM grants WHERE username = 'oyente-dos' AND tenant_id = 'SIPGES/PRJ-SECHURA'`)
	writeEntry(t, conn, north.TenantID())
	if n := stream.activity(); n != 1 {
		t.Fatalf("%d events", n)
	}
}
