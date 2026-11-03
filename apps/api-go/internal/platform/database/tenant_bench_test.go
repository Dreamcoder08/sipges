package database_test

import (
	"context"
	"net/url"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/database"
)

// BenchmarkWithTenant compares the pipelined tenant transaction with entering first and then
// querying. Run: SIPGES_TEST_DATABASE_URL=… go test -run '^$' -bench WithTenant ./internal/platform/database/
func BenchmarkWithTenant(b *testing.B) {
	if scratch == nil {
		b.Skip(EnvAdminURLHint)
	}
	ctx := context.Background()
	b.Run("pipelined", func(b *testing.B) {
		pool := newPool(b, 16)
		b.RunParallel(func(pb *testing.PB) {
			for pb.Next() {
				if _, err := database.WithTenant(ctx, pool, "ACME/NORTE", func(ctx context.Context, q database.Querier) ([]string, error) {
					return values(ctx, q, "SELECT id FROM module_records")
				}); err != nil {
					b.Error(err)
					return
				}
			}
		})
	})
	b.Run("enter-then-query", func(b *testing.B) {
		pool := newPool(b, 16)
		b.RunParallel(func(pb *testing.PB) {
			for pb.Next() {
				if err := pgx.BeginFunc(ctx, pool, func(tx pgx.Tx) error {
					if err := database.EnterTenant(ctx, tx, "ACME/NORTE"); err != nil {
						return err
					}
					_, err := values(ctx, tx, "SELECT id FROM module_records")
					return err
				}); err != nil {
					b.Error(err)
					return
				}
			}
		})
	})
}

// EnvAdminURLHint explains why integration benchmarks skip.
const EnvAdminURLHint = "SIPGES_TEST_DATABASE_URL is not set"

// BenchmarkWithTenantRemote runs both forms sequentially on one connection behind a proxy that
// adds 2 ms before each client write, so round trips dominate as they do against a remote
// database. Expect about 3 trips (6 ms) pipelined and 4 (8 ms) entering first.
func BenchmarkWithTenantRemote(b *testing.B) {
	if scratch == nil {
		b.Skip(EnvAdminURLHint)
	}
	ctx := context.Background()
	parsed, err := url.Parse(scratch.URL)
	if err != nil {
		b.Fatal(err)
	}
	proxy := startProxy(b, parsed.Host, 2*time.Millisecond)
	conn, err := pgx.Connect(ctx, proxy.url(parsed))
	if err != nil {
		b.Fatal(err)
	}
	b.Cleanup(func() { _ = conn.Close(context.Background()) })
	work := func(ctx context.Context, q database.Querier) ([]string, error) {
		return values(ctx, q, "SELECT id FROM module_records WHERE module = $1", "Eventos")
	}
	b.Run("pipelined", func(b *testing.B) {
		proxy.writes.Store(0)
		defer func() { b.ReportMetric(float64(proxy.writes.Load())/float64(b.N), "trips/op") }()
		for b.Loop() {
			if _, err := database.WithTenant(ctx, conn, "ACME/NORTE", work); err != nil {
				b.Fatal(err)
			}
		}
	})
	b.Run("enter-then-query", func(b *testing.B) {
		proxy.writes.Store(0)
		defer func() { b.ReportMetric(float64(proxy.writes.Load())/float64(b.N), "trips/op") }()
		for b.Loop() {
			if err := pgx.BeginFunc(ctx, conn, func(tx pgx.Tx) error {
				if err := database.EnterTenant(ctx, tx, "ACME/NORTE"); err != nil {
					return err
				}
				_, err := work(ctx, tx)
				return err
			}); err != nil {
				b.Fatal(err)
			}
		}
	})
}
