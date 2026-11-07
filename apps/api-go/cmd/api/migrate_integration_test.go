package main

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/database"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/database/dbtest"
)

func emptyOwned(t *testing.T) *dbtest.Scratch {
	t.Helper()
	admin := os.Getenv(dbtest.EnvAdminURL)
	if admin == "" {
		t.Skip(dbtest.EnvAdminURL + " is not set")
	}
	scratch, err := dbtest.NewEmptyOwnedScratch(context.Background(), admin)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = scratch.Drop(context.WithoutCancel(context.Background())) })
	return scratch
}

func migrateEnv(url, dir string) func(string) (string, bool) {
	return lookup(map[string]string{"SIPGES_DATABASE_URL": url, "SIPGES_MIGRATIONS_DIR": dir})
}

func countVersions(t *testing.T, url string) int {
	t.Helper()
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = conn.Close(ctx) }()
	var n int
	if err := conn.QueryRow(ctx, "SELECT count(*) FROM schema_migrations").Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

// The install's first run: every migration, as the owner the API also logs in with, then a second
// run that changes nothing.
func TestMigrateAppliesEveryMigrationAsAnUnprivilegedOwner(t *testing.T) {
	scratch := emptyOwned(t)
	files, err := filepath.Glob(filepath.Join(dbtest.MigrationsDir(), "*.sql"))
	if err != nil || len(files) == 0 {
		t.Fatalf("migrations: %v, %d", err, len(files))
	}
	var out bytes.Buffer
	if err := runMigrate(context.Background(), migrateEnv(scratch.URL, dbtest.MigrationsDir()), &out); err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(out.String(), "Applied ") {
		t.Fatalf("first run said %q", out.String())
	}
	if got := countVersions(t, scratch.URL); got != len(files) {
		t.Fatalf("versions = %d, want %d", got, len(files))
	}
	out.Reset()
	if err := runMigrate(context.Background(), migrateEnv(scratch.URL, dbtest.MigrationsDir()), &out); err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(out.String(), "Database up to date") {
		t.Fatalf("second run said %q", out.String())
	}
}

// A superuser or BYPASSRLS owner would never exercise FORCE ROW LEVEL SECURITY, and every table
// it created would belong to the wrong role.
func TestMigrateRefusesAPrivilegedLogin(t *testing.T) {
	admin := os.Getenv(dbtest.EnvAdminURL)
	if admin == "" {
		t.Skip(dbtest.EnvAdminURL + " is not set")
	}
	dir := t.TempDir()
	writeMigration(t, dir, "0001_marker.sql", "CREATE TABLE migrate_must_not_exist (id int);")
	err := runMigrate(context.Background(), migrateEnv(admin, dir), &bytes.Buffer{})
	if !errors.Is(err, database.ErrPrivilegedRole) {
		t.Fatalf("err = %v", err)
	}
}

func TestMigrateStopsAtAFailureAndKeepsTheOnesBefore(t *testing.T) {
	scratch := emptyOwned(t)
	dir := t.TempDir()
	writeMigration(t, dir, "0001_first.sql", "CREATE TABLE first_ok (id int); CREATE TABLE second_ok (id int);")
	writeMigration(t, dir, "0002_broken.sql", "CREATE TABLE half_done (id int); SELECT no_such_function();")
	writeMigration(t, dir, "0003_never.sql", "CREATE TABLE never_reached (id int);")
	err := runMigrate(context.Background(), migrateEnv(scratch.URL, dir), &bytes.Buffer{})
	if err == nil || !strings.Contains(err.Error(), "0002_broken") {
		t.Fatalf("err = %v", err)
	}
	password := strings.SplitN(strings.SplitN(scratch.URL, "@", 2)[0], ":", 3)[2]
	if strings.Contains(err.Error(), password) {
		t.Fatal("the error carries the password")
	}
	if got := countVersions(t, scratch.URL); got != 1 {
		t.Fatalf("versions = %d, want 1", got)
	}
	ctx := context.Background()
	conn, connErr := pgx.Connect(ctx, scratch.URL)
	if connErr != nil {
		t.Fatal(connErr)
	}
	defer func() { _ = conn.Close(ctx) }()
	var half, never *string
	if err := conn.QueryRow(ctx, "SELECT to_regclass('half_done')::text, to_regclass('never_reached')::text").Scan(&half, &never); err != nil {
		t.Fatal(err)
	}
	if half != nil || never != nil {
		t.Fatalf("half_done %v, never_reached %v: a failed file left something", half, never)
	}
}

// compose restarts the job after a crash, and an operator may run it by hand meanwhile.
func TestMigrateRunsConcurrentlyWithoutApplyingTwice(t *testing.T) {
	scratch := emptyOwned(t)
	var wg sync.WaitGroup
	errs := make([]error, 3)
	for i := range errs {
		wg.Go(func() {
			errs[i] = runMigrate(context.Background(), migrateEnv(scratch.URL, dbtest.MigrationsDir()), &bytes.Buffer{})
		})
	}
	wg.Wait()
	if err := errors.Join(errs...); err != nil {
		t.Fatal(err)
	}
}
