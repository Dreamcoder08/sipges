package database_test

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net"
	"net/url"
	"os"
	"slices"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/database"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/database/dbtest"
)

// Ported from apps/api/test/platform/tenant-transaction.test.ts and
// apps/api/test/integration/tenancy-postgres.test.ts: they prove the isolation every
// tenant-owned table relies on (docs/adr/0003) against a real, migrated PostgreSQL.

var scratch *dbtest.Scratch

func TestMain(m *testing.M) {
	os.Exit(run(m))
}

func run(m *testing.M) int {
	adminURL := os.Getenv(dbtest.EnvAdminURL)
	if adminURL == "" {
		return m.Run() // integration tests skip themselves
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	s, err := dbtest.NewScratch(ctx, adminURL)
	if err != nil {
		fmt.Fprintln(os.Stderr, "scratch database:", err)
		return 1
	}
	defer func() {
		if err := s.Drop(context.Background()); err != nil {
			fmt.Fprintln(os.Stderr, "drop scratch database:", err)
		}
	}()
	if err := seed(ctx, s.URL); err != nil {
		fmt.Fprintln(os.Stderr, "seed scratch database:", err)
		return 1
	}
	scratch = s
	return m.Run()
}

// seed inserts synthetic rows as the owner; tests read them back as sipges_tenant.
func seed(ctx context.Context, dsn string) error {
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		return err
	}
	defer func() { _ = conn.Close(ctx) }()
	_, err = conn.Exec(ctx, `
		CREATE TABLE rls_probe (tenant_id text NOT NULL, value text NOT NULL);
		ALTER TABLE rls_probe ENABLE ROW LEVEL SECURITY;
		ALTER TABLE rls_probe FORCE ROW LEVEL SECURITY;
		CREATE POLICY tenant_isolation ON rls_probe
		  USING (tenant_id = current_setting('app.tenant_id', true))
		  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
		GRANT SELECT, INSERT, UPDATE, DELETE ON rls_probe TO sipges_tenant;
		INSERT INTO rls_probe VALUES ('ACME/NORTE', 'north'), ('SIPGES/PRJ-SECHURA', 'sechura');
		INSERT INTO tenants (company_id, project_id, label) VALUES
		  ('SIPGES','PRJ-SECHURA','South'), ('ACME','NORTE','North') ON CONFLICT DO NOTHING;
		INSERT INTO module_records (tenant_id, module, id, payload, created_at, updated_at) VALUES
		  ('SIPGES/PRJ-SECHURA','Eventos','south','{"name":"south"}', now(), now()),
		  ('ACME/NORTE','Eventos','north','{"name":"north"}', now(), now());`)
	return err
}

func requireDB(t *testing.T) {
	t.Helper()
	if scratch == nil {
		t.Skip(dbtest.EnvAdminURL + " is not set")
	}
}

func newPool(t testing.TB, maxConns int32) *pgxpool.Pool {
	t.Helper()
	cfg, err := pgxpool.ParseConfig(scratch.URL)
	if err != nil {
		t.Fatal(err)
	}
	cfg.MaxConns = maxConns
	pool, err := pgxpool.NewWithConfig(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func values(ctx context.Context, q database.Querier, sql string, args ...any) ([]string, error) {
	rows, err := q.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowTo[string])
}

func pgCode(err error) string {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		return pgErr.Code
	}
	return ""
}

func TestWithTenantShowsEachTenantOnlyItsRows(t *testing.T) {
	requireDB(t)
	pool := newPool(t, 2)
	ctx := context.Background()
	for tenant, want := range map[string][]string{
		"ACME/NORTE":         {"north"},
		"SIPGES/PRJ-SECHURA": {"sechura"},
		"OTHER/X":            nil,
	} {
		got, err := database.WithTenant(ctx, pool, tenant, func(ctx context.Context, q database.Querier) ([]string, error) {
			return values(ctx, q, "SELECT value FROM rls_probe")
		})
		if err != nil {
			t.Fatalf("%s: %v", tenant, err)
		}
		if !slices.Equal(got, want) {
			t.Fatalf("%s: got %v, want %v", tenant, got, want)
		}
	}
}

func TestWithTenantIsolatesSimultaneousTransactionsAcrossTwoPools(t *testing.T) {
	requireDB(t)
	pools := []*pgxpool.Pool{newPool(t, 4), newPool(t, 4)}
	ctx := context.Background()
	var wg sync.WaitGroup
	errs := make(chan error, 24)
	for i := range 24 {
		wg.Go(func() {
			north := i%2 == 0
			tenant, want := "SIPGES/PRJ-SECHURA", "south"
			if north {
				tenant, want = "ACME/NORTE", "north"
			}
			_, err := database.WithTenant(ctx, pools[i%3%2], tenant, func(ctx context.Context, q database.Querier) (struct{}, error) {
				if _, err := q.Exec(ctx, "SELECT pg_sleep(0.01)"); err != nil {
					return struct{}{}, err
				}
				got, err := values(ctx, q, "SELECT id FROM module_records")
				if err != nil {
					return struct{}{}, err
				}
				if !slices.Equal(got, []string{want}) {
					return struct{}{}, fmt.Errorf("job %d (%s): got %v, want [%s]", i, tenant, got, want)
				}
				return struct{}{}, nil
			})
			errs <- err
		})
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Error(err)
		}
	}
}

func TestWithTenantRejectsCrossTenantWritesAndLeavesDataUnchanged(t *testing.T) {
	requireDB(t)
	pool := newPool(t, 2)
	ctx := context.Background()
	_, err := database.WithTenant(ctx, pool, "ACME/NORTE", func(ctx context.Context, q database.Querier) (pgconn.CommandTag, error) {
		return q.Exec(ctx, "INSERT INTO rls_probe VALUES ($1, $2)", "SIPGES/PRJ-SECHURA", "intruder")
	})
	if pgCode(err) != "42501" {
		t.Fatalf("insert into another tenant: err = %v, want 42501 row-level security", err)
	}
	_, err = database.WithTenant(ctx, pool, "ACME/NORTE", func(ctx context.Context, q database.Querier) (pgconn.CommandTag, error) {
		return q.Exec(ctx, "INSERT INTO module_records VALUES ('SIPGES/PRJ-SECHURA','Eventos','intruder','{}',now(),now())")
	})
	if pgCode(err) != "42501" {
		t.Fatalf("insert module record into another tenant: err = %v, want 42501", err)
	}
	updated, err := database.WithTenant(ctx, pool, "ACME/NORTE", func(ctx context.Context, q database.Querier) ([]string, error) {
		return values(ctx, q, "UPDATE rls_probe SET value = 'hijacked' WHERE tenant_id = 'SIPGES/PRJ-SECHURA' RETURNING value")
	})
	if err != nil || len(updated) != 0 {
		t.Fatalf("update of another tenant: rows %v, err %v; want none", updated, err)
	}
	all, err := values(ctx, pool, "SELECT value FROM rls_probe ORDER BY value")
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(all, []string{"north", "sechura"}) {
		t.Fatalf("rls_probe = %v after the attempts", all)
	}
	ids, err := values(ctx, pool, "SELECT id FROM module_records ORDER BY id")
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(ids, []string{"north", "south"}) {
		t.Fatalf("module_records = %v after the attempts", ids)
	}
}

func TestWithTenantCannotReadIdentityTables(t *testing.T) {
	requireDB(t)
	pool := newPool(t, 1)
	for _, sql := range []string{"SELECT password_hash FROM users", "SELECT token_hash FROM sessions"} {
		_, err := database.WithTenant(context.Background(), pool, "ACME/NORTE", func(ctx context.Context, q database.Querier) ([]string, error) {
			return values(ctx, q, sql)
		})
		if pgCode(err) != "42501" {
			t.Fatalf("%s: err = %v, want 42501 permission denied", sql, err)
		}
	}
}

func TestWithTenantResetsPooledSettingsAfterCommitAndRollback(t *testing.T) {
	requireDB(t)
	// One connection: the next query certainly reuses the connection the tenant used.
	pool := newPool(t, 1)
	ctx := database.WithActor(context.Background(), database.Actor{Name: "ana.perez", Clearance: database.ClearanceLimited})
	check := func(when string) {
		t.Helper()
		var role, tenant, actor, clearance string
		err := pool.QueryRow(context.Background(), `SELECT current_user,
			coalesce(current_setting('app.tenant_id', true), ''),
			coalesce(current_setting('app.actor', true), ''),
			coalesce(current_setting('app.clearance', true), '')`).Scan(&role, &tenant, &actor, &clearance)
		if err != nil {
			t.Fatal(err)
		}
		if role == "sipges_tenant" || tenant != "" || actor != "" || clearance != "" {
			t.Fatalf("after %s: role=%q tenant=%q actor=%q clearance=%q, want owner and no settings", when, role, tenant, actor, clearance)
		}
	}
	if _, err := database.WithTenant(ctx, pool, "ACME/NORTE", func(ctx context.Context, q database.Querier) ([]string, error) {
		return values(ctx, q, "SELECT value FROM rls_probe")
	}); err != nil {
		t.Fatal(err)
	}
	check("commit")
	workErr := errors.New("synthetic work failure")
	if _, err := database.WithTenant(ctx, pool, "ACME/NORTE", func(ctx context.Context, q database.Querier) ([]string, error) {
		if _, err := values(ctx, q, "SELECT value FROM rls_probe"); err != nil {
			return nil, err
		}
		return nil, workErr
	}); !errors.Is(err, workErr) {
		t.Fatalf("err = %v, want the work's error", err)
	}
	check("rollback")
	if _, err := database.WithTenant(ctx, pool, "ACME/NORTE", func(context.Context, database.Querier) (struct{}, error) {
		return struct{}{}, nil
	}); err != nil {
		t.Fatal(err)
	}
	check("a transaction without queries")
}

func TestWithTenantRollsBackTheWorkOnError(t *testing.T) {
	requireDB(t)
	pool := newPool(t, 1)
	workErr := errors.New("synthetic work failure")
	_, err := database.WithTenant(context.Background(), pool, "ACME/NORTE", func(ctx context.Context, q database.Querier) (struct{}, error) {
		if _, err := q.Exec(ctx, "INSERT INTO rls_probe VALUES ($1, $2)", "ACME/NORTE", "rolled-back"); err != nil {
			return struct{}{}, err
		}
		return struct{}{}, workErr
	})
	if !errors.Is(err, workErr) {
		t.Fatalf("err = %v, want the work's error", err)
	}
	var n int
	if err := pool.QueryRow(context.Background(), "SELECT count(*) FROM rls_probe WHERE value = 'rolled-back'").Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatalf("%d rolled-back rows were committed", n)
	}
}

func TestWithTenantSetsSettingsAndRoleForThePipelinedFirstQuery(t *testing.T) {
	requireDB(t)
	pool := newPool(t, 2)
	ctx := database.WithActor(context.Background(), database.Actor{Name: "ana.perez", Clearance: database.ClearanceLimited})
	for i := range 5 {
		got, err := database.WithTenant(ctx, pool, "ACME/NORTE", func(ctx context.Context, q database.Querier) ([]string, error) {
			var role, tenant, actor, clearance, n string
			err := q.QueryRow(ctx, `SELECT current_user, current_setting('app.tenant_id'), current_setting('app.actor'),
				current_setting('app.clearance'), $1::text`, fmt.Sprint(i)).Scan(&role, &tenant, &actor, &clearance, &n)
			return []string{role, tenant, actor, clearance, n}, err
		})
		if err != nil {
			t.Fatal(err)
		}
		want := []string{"sipges_tenant", "ACME/NORTE", "ana.perez", "limited", fmt.Sprint(i)}
		if !slices.Equal(got, want) {
			t.Fatalf("got %v, want %v", got, want)
		}
	}
}

func TestWithTenantFirstExecWithoutArgumentsMayHoldSeveralStatements(t *testing.T) {
	requireDB(t)
	pool := newPool(t, 1)
	got, err := database.WithTenant(context.Background(), pool, "ACME/NORTE", func(ctx context.Context, q database.Querier) ([]string, error) {
		if _, err := q.Exec(ctx, "SET LOCAL statement_timeout = '5s'; SET LOCAL lock_timeout = '1s'"); err != nil {
			return nil, err
		}
		return values(ctx, q, "SELECT current_user || ' ' || current_setting('statement_timeout')")
	})
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(got, []string{"sipges_tenant 5s"}) {
		t.Fatalf("got %v", got)
	}
}

func TestWithTenantKeepsHostileTenantIDAsOneLiteral(t *testing.T) {
	requireDB(t)
	pool := newPool(t, 1)
	hostile := `X\'); SET LOCAL ROLE postgres; SELECT ('`
	got, err := database.WithTenant(context.Background(), pool, hostile, func(ctx context.Context, q database.Querier) ([]string, error) {
		var role, tenant string
		var rows int
		err := q.QueryRow(ctx, "SELECT current_user, current_setting('app.tenant_id'), (SELECT count(*)::int FROM rls_probe)").Scan(&role, &tenant, &rows)
		return []string{role, tenant, fmt.Sprint(rows)}, err
	})
	if err != nil {
		t.Fatal(err)
	}
	if want := []string{"sipges_tenant", hostile, "0"}; !slices.Equal(got, want) {
		t.Fatalf("got %q, want %q", got, want)
	}
}

func TestWithTenantRefusesInvalidTenantIDs(t *testing.T) {
	requireDB(t)
	pool := newPool(t, 1)
	for tenant, want := range map[string]error{"": database.ErrTenantRequired, "ACME\x00NORTE": database.ErrInvalidSetting} {
		_, err := database.WithTenant(context.Background(), pool, tenant, func(context.Context, database.Querier) (struct{}, error) {
			t.Fatal("work must not run")
			return struct{}{}, nil
		})
		if !errors.Is(err, want) {
			t.Fatalf("tenant %q: err = %v, want %v", tenant, err, want)
		}
	}
}

// countingTracer counts the statements pgx sends through its query path.
type countingTracer struct{ sent []string }

func (c *countingTracer) TraceQueryStart(ctx context.Context, _ *pgx.Conn, data pgx.TraceQueryStartData) context.Context {
	c.sent = append(c.sent, data.SQL)
	return ctx
}

func (*countingTracer) TraceQueryEnd(context.Context, *pgx.Conn, pgx.TraceQueryEndData) {}

func TestEnterTenantSendsOneStatement(t *testing.T) {
	requireDB(t)
	cfg, err := pgx.ParseConfig(scratch.URL)
	if err != nil {
		t.Fatal(err)
	}
	tracer := &countingTracer{}
	cfg.Tracer = tracer
	ctx := context.Background()
	conn, err := pgx.ConnectConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = conn.Close(ctx) }()
	tx, err := conn.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tracer.sent = nil
	if err := database.EnterTenant(ctx, tx, "ACME/NORTE"); err != nil {
		t.Fatal(err)
	}
	if len(tracer.sent) != 1 {
		t.Fatalf("EnterTenant sent %d statements: %q", len(tracer.sent), tracer.sent)
	}
	var role, tenant, clearance string
	if err := tx.QueryRow(ctx, "SELECT current_user, current_setting('app.tenant_id'), current_setting('app.clearance')").Scan(&role, &tenant, &clearance); err != nil {
		t.Fatal(err)
	}
	if role != "sipges_tenant" || tenant != "ACME/NORTE" || clearance != "full" {
		t.Fatalf("role=%q tenant=%q clearance=%q", role, tenant, clearance)
	}
}

// countingProxy forwards TCP to PostgreSQL and counts the client's writes: with a client that
// waits for each answer, every count is one network round trip.
type countingProxy struct {
	ln     net.Listener
	target string
	writes atomic.Int64
	// delay is added before forwarding each client write, simulating a remote database.
	delay time.Duration
}

func startProxy(t testing.TB, target string, delay time.Duration) *countingProxy {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	p := &countingProxy{ln: ln, target: target, delay: delay}
	t.Cleanup(func() { _ = ln.Close() })
	go p.serve()
	return p
}

// url points a copy of target at the proxy, without TLS (local synthetic server only).
func (p *countingProxy) url(target *url.URL) string {
	u := *target
	u.Host = p.ln.Addr().String()
	q := u.Query()
	q.Set("sslmode", "disable")
	u.RawQuery = q.Encode()
	return u.String()
}

func (p *countingProxy) serve() {
	for {
		client, err := p.ln.Accept()
		if err != nil {
			return
		}
		server, err := net.Dial("tcp", p.target)
		if err != nil {
			_ = client.Close()
			continue
		}
		go func() {
			defer func() { _ = server.Close() }()
			buf := make([]byte, 64<<10)
			for {
				n, err := client.Read(buf)
				if n > 0 {
					p.writes.Add(1)
					time.Sleep(p.delay)
					if _, werr := server.Write(buf[:n]); werr != nil {
						return
					}
				}
				if err != nil {
					return
				}
			}
		}()
		go func() {
			defer func() { _ = client.Close() }()
			_, _ = io.Copy(client, server)
		}()
	}
}

func TestWithTenantCostsOneRoundTripBeyondBeginAndCommit(t *testing.T) {
	requireDB(t)
	parsed, err := url.Parse(scratch.URL)
	if err != nil {
		t.Fatal(err)
	}
	proxy := startProxy(t, parsed.Host, 0)
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, proxy.url(parsed))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = conn.Close(ctx) }()
	proxy.writes.Store(0)
	got, err := database.WithTenant(ctx, conn, "ACME/NORTE", func(ctx context.Context, q database.Querier) ([]string, error) {
		return values(ctx, q, "SELECT value FROM rls_probe")
	})
	if err != nil || !slices.Equal(got, []string{"north"}) {
		t.Fatalf("got %v, err %v", got, err)
	}
	// BEGIN, then the tenant statement pipelined with the first query, then COMMIT.
	if n := proxy.writes.Load(); n != 3 {
		t.Fatalf("WithTenant took %d round trips, want 3 (BEGIN, settings+first query, COMMIT)", n)
	}
}

func TestWithTenantReportsAFailureToEnterAndReturnsNothingFromThePipelinedQuery(t *testing.T) {
	requireDB(t)
	ctx := context.Background()
	// A login that is not a member of sipges_tenant cannot switch role: the query sent right
	// behind the tenant statement must be rejected with the aborted transaction (25P02).
	suffix := make([]byte, 4)
	_, _ = rand.Read(suffix)
	role := "probe_" + hex.EncodeToString(suffix)
	const password = "synthetic-probe-password"
	if err := scratch.AdminExec(ctx, "CREATE ROLE "+role+" LOGIN PASSWORD '"+password+"'"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = scratch.AdminExec(context.Background(), "DROP ROLE IF EXISTS "+role) })
	conn, err := pgx.Connect(ctx, scratch.URLAs(role, password))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close(context.Background()) })

	for _, first := range []string{"query", "exec", "queryrow"} {
		reached := "not reached"
		var leaked []string
		_, err := database.WithTenant(ctx, conn, "ACME/NORTE", func(ctx context.Context, q database.Querier) (struct{}, error) {
			var werr error
			switch first {
			case "query":
				leaked, werr = values(ctx, q, "SELECT 'leaked'")
			case "exec":
				_, werr = q.Exec(ctx, "SELECT $1::text", "leaked")
			case "queryrow":
				var s string
				werr = q.QueryRow(ctx, "SELECT 'leaked'").Scan(&s)
				if s != "" {
					leaked = []string{s}
				}
			}
			reached = pgCode(werr)
			return struct{}{}, werr
		})
		if pgCode(err) != "42501" {
			t.Fatalf("%s: err = %v, want the failure to enter (42501)", first, err)
		}
		if reached != "25P02" {
			t.Fatalf("%s: the pipelined query got %q, want 25P02", first, reached)
		}
		if len(leaked) != 0 {
			t.Fatalf("%s: the pipelined query returned %v", first, leaked)
		}
		// The connection stays usable after the failed transaction.
		var one int
		if err := conn.QueryRow(ctx, "SELECT 1").Scan(&one); err != nil || one != 1 {
			t.Fatalf("%s: connection unusable afterwards: %v", first, err)
		}
	}
}

func TestWithTenantClosesRowsTheWorkLeftOpen(t *testing.T) {
	requireDB(t)
	pool := newPool(t, 1)
	_, err := database.WithTenant(context.Background(), pool, "ACME/NORTE", func(ctx context.Context, q database.Querier) (struct{}, error) {
		_, err := q.Query(ctx, "SELECT value FROM rls_probe") //nolint:sqlclosecheck // deliberately left open: WithTenant must close it
		return struct{}{}, err
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := values(context.Background(), pool, "SELECT value FROM rls_probe"); err != nil {
		t.Fatalf("pool unusable afterwards: %v", err)
	}
}
