package app

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/database/dbtest"
)

// bootstrapDatabase is a scratch database of this test alone, so a stored label it rewrites
// never meets another test's rows.
func bootstrapDatabase(t *testing.T) *pgxpool.Pool {
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
	return pool
}

func defaultLabel(t *testing.T, pool *pgxpool.Pool) string {
	t.Helper()
	var label string
	if err := pool.QueryRow(t.Context(),
		`SELECT label FROM tenants WHERE tenant_id = 'SIPGES/PRJ-SECHURA'`).Scan(&label); err != nil {
		t.Fatal(err)
	}
	return label
}

// functional-10 T6: a new installation names its default project «Proyecto principal», and a
// later bootstrap never renames the label an existing installation stored (no migration).
func TestBootstrapTenancyNamesANewProjectAndKeepsAStoredLabel(t *testing.T) {
	pool := bootstrapDatabase(t)
	at := time.Date(2026, 11, 15, 12, 0, 0, 0, time.UTC)
	now := func() time.Time { return at }

	if err := bootstrapTenancy(t.Context(), pool, now); err != nil {
		t.Fatal(err)
	}
	if got := defaultLabel(t, pool); got != "Proyecto principal" {
		t.Fatalf("fresh database label = %q", got)
	}

	const stored = "Proyecto Sechura (migración)"
	if _, err := pool.Exec(t.Context(),
		`UPDATE tenants SET label = $1 WHERE tenant_id = 'SIPGES/PRJ-SECHURA'`, stored); err != nil {
		t.Fatal(err)
	}
	if err := bootstrapTenancy(t.Context(), pool, now); err != nil {
		t.Fatal(err)
	}
	if got := defaultLabel(t, pool); got != stored {
		t.Fatalf("label after a later bootstrap = %q, want %q", got, stored)
	}
	var tenants int
	if err := pool.QueryRow(t.Context(), `SELECT count(*) FROM tenants`).Scan(&tenants); err != nil {
		t.Fatal(err)
	}
	if tenants != 1 {
		t.Fatalf("tenants = %d after two bootstraps", tenants)
	}
}
