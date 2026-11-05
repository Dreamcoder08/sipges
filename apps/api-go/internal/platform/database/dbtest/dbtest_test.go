package dbtest_test

import (
	"context"
	"fmt"
	"net/url"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/database/dbtest"
)

// go test runs packages in parallel, each creating its own scratch database. The migrations
// create and later rename a cluster-wide role (0003 creates mascli_tenant, 0030 renames it), so
// two scratch databases migrating at once must not interleave: one renaming the role while the
// other still grants it failed with `role "mascli_tenant" does not exist` in CI.
func TestConcurrentScratchDatabasesMigrate(t *testing.T) {
	adminURL := os.Getenv("SIPGES_TEST_DATABASE_URL")
	if adminURL == "" {
		t.Skip("SIPGES_TEST_DATABASE_URL not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	const n = 4
	var wg sync.WaitGroup
	errs := make([]error, n)
	for i := range n {
		wg.Add(1)
		go func() {
			defer wg.Done()
			scratch, err := dbtest.NewScratch(ctx, adminURL)
			if err != nil {
				errs[i] = err
				return
			}
			errs[i] = scratch.Drop(ctx)
		}()
	}
	wg.Wait()
	for i, err := range errs {
		if err != nil {
			t.Errorf("scratch %d: %v", i, err)
		}
	}
}

// A test that migrates a database of its own takes the same lock as NewScratch: 0030 drops
// mascli_tenant, so running it beside another package's 0003 failed in CI the same way.
func TestMigrateDatabaseWaitsForTheLockOfScratchMigrations(t *testing.T) {
	adminURL := os.Getenv("SIPGES_TEST_DATABASE_URL")
	if adminURL == "" {
		t.Skip("SIPGES_TEST_DATABASE_URL not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	admin, err := pgx.Connect(ctx, adminURL)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = admin.Close(context.Background()) }()
	name := fmt.Sprintf("sipges_go_bare_lock_%d", time.Now().UnixNano())
	if _, err := admin.Exec(ctx, "CREATE DATABASE "+name); err != nil {
		t.Fatal(err)
	}
	defer func() { _, _ = admin.Exec(context.Background(), "DROP DATABASE IF EXISTS "+name+" WITH (FORCE)") }()
	u, err := url.Parse(adminURL)
	if err != nil {
		t.Fatal(err)
	}
	u.Path = "/" + name
	if _, err := admin.Exec(ctx, "SELECT pg_advisory_lock($1)", dbtest.ScratchLockKey); err != nil {
		t.Fatal(err)
	}

	done := make(chan error, 1)
	go func() { done <- dbtest.MigrateDatabase(ctx, adminURL, u.String()) }()
	select {
	case err := <-done:
		t.Fatalf("migrated while another package held the lock: %v", err)
	case <-time.After(300 * time.Millisecond):
	}
	target, err := pgx.Connect(ctx, u.String())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = target.Close(context.Background()) }()
	var touched bool
	if err := target.QueryRow(ctx, `SELECT to_regclass('schema_migrations') IS NOT NULL`).Scan(&touched); err != nil {
		t.Fatal(err)
	}
	if touched {
		t.Fatal("the migration started while another package held the lock")
	}
	if _, err := admin.Exec(ctx, "SELECT pg_advisory_unlock($1)", dbtest.ScratchLockKey); err != nil {
		t.Fatal(err)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}
