package database_test

import (
	"context"
	"fmt"
	"net/url"
	"os"
	"slices"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/database"
)

// EnvPoolerAddr names host:port of a PgBouncer in transaction pooling mode in front of the test
// server (scripts/agents/test-pgbouncer.sh addr): what Cloudflare Hyperdrive and PlanetScale's
// pooler do to the API's connections. Each transaction may run on a different server connection
// and a few server connections serve every client, so any state outside a transaction would
// leak to another tenant or vanish.
const EnvPoolerAddr = "SIPGES_TEST_POOLER_ADDR"

// pooledURL is the scratch database reached through the pooler, or a skip without one.
func pooledURL(t *testing.T) string {
	t.Helper()
	requireDB(t)
	addr := os.Getenv(EnvPoolerAddr)
	if addr == "" {
		t.Skip(EnvPoolerAddr + " is not set")
	}
	u, err := url.Parse(scratch.URL)
	if err != nil {
		t.Fatal(err)
	}
	u.Host = addr
	return u.String()
}

// openPooled opens the pool exactly as the API does, through the pooler, with more client
// connections than the pooler has server connections.
func openPooled(t *testing.T, query string) *pgxpool.Pool {
	t.Helper()
	pool, err := database.Open(context.Background(), pooledURL(t)+"?pool_max_conns=12"+query)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	return pool
}

var pooledTenants = []struct{ id, record, probe string }{
	{"ACME/NORTE", "north", "north"},
	{"SIPGES/PRJ-SECHURA", "south", "sechura"},
	{"OTHER/X", "", ""},
}

// tenantJob runs one tenant transaction the way the API does, with parameterized queries that a
// statement cache would prepare, and reports anything it sees from another tenant.
func tenantJob(ctx context.Context, pool *pgxpool.Pool, i int) error {
	tenant := pooledTenants[i%len(pooledTenants)]
	_, err := database.WithTenant(ctx, pool, tenant.id, func(ctx context.Context, q database.Querier) (struct{}, error) {
		var setting, role string
		if err := q.QueryRow(ctx, "SELECT current_setting('app.tenant_id', true), current_user").Scan(&setting, &role); err != nil {
			return struct{}{}, err
		}
		if setting != tenant.id || role != "sipges_tenant" {
			return struct{}{}, fmt.Errorf("job %d (%s): app.tenant_id=%q role=%q", i, tenant.id, setting, role)
		}
		ids, err := values(ctx, q, "SELECT id FROM module_records WHERE module = $1 ORDER BY id", "Eventos")
		if err != nil {
			return struct{}{}, err
		}
		probes, err := values(ctx, q, "SELECT value FROM rls_probe WHERE value <> $1 ORDER BY value", "")
		if err != nil {
			return struct{}{}, err
		}
		if !slices.Equal(ids, nonEmpty(tenant.record)) || !slices.Equal(probes, nonEmpty(tenant.probe)) {
			return struct{}{}, fmt.Errorf("job %d (%s): cross-tenant rows: records %v, probes %v", i, tenant.id, ids, probes)
		}
		return struct{}{}, nil
	})
	if err != nil {
		return err
	}
	// The next statement outside a tenant transaction, on whatever server connection the pooler
	// picks, must see no tenant, no actor and the login role: nothing outlived the transaction.
	var setting, actor, role string
	err = pool.QueryRow(ctx, `SELECT coalesce(current_setting('app.tenant_id', true), ''),
	    coalesce(current_setting('app.actor', true), ''), current_user`).Scan(&setting, &actor, &role)
	if err != nil {
		return err
	}
	if setting != "" || actor != "" || role == "sipges_tenant" {
		return fmt.Errorf("job %d: state leaked past the transaction: tenant=%q actor=%q role=%q", i, setting, actor, role)
	}
	return nil
}

func nonEmpty(value string) []string {
	if value == "" {
		return []string{}
	}
	return []string{value}
}

func runConcurrentTenants(t *testing.T, pool *pgxpool.Pool, jobs int) {
	t.Helper()
	ctx := t.Context()
	errs := make(chan error, jobs)
	var wg sync.WaitGroup
	for i := range jobs {
		wg.Go(func() { errs <- tenantJob(ctx, pool, i) })
	}
	wg.Wait()
	close(errs)
	failures := 0
	for err := range errs {
		if err != nil {
			failures++
			if failures <= 5 {
				t.Error(err)
			}
		}
	}
	if failures > 0 {
		t.Fatalf("%d of %d tenant jobs failed through the transaction pooler", failures, jobs)
	}
}

func TestPooledWithTenantKeepsTenantsApartUnderTransactionPooling(t *testing.T) {
	runConcurrentTenants(t, openPooled(t, ""), 600)
}

// A pooler without protocol-level prepared statements (PgBouncer max_prepared_statements=0, the
// strictest) must still serve every statement the API runs, also when the URL says nothing.
func TestPooledOpenNeedsNoNamedPreparedStatements(t *testing.T) {
	pool := openPooled(t, "")
	if got := pool.Config().ConnConfig.DefaultQueryExecMode; got != pgx.QueryExecModeCacheDescribe {
		t.Fatalf("DefaultQueryExecMode = %v, want cache_describe", got)
	}
	ctx := t.Context()
	for i := range 50 {
		var n int
		if err := pool.QueryRow(ctx, "SELECT $1::int + 1", i).Scan(&n); err != nil {
			t.Fatalf("query %d: %v", i, err)
		}
		if n != i+1 {
			t.Fatalf("query %d = %d", i, n)
		}
	}
}
