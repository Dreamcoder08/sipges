package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"

	"github.com/jackc/pgx/v5/pgconn"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/config"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/database"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/database/migrator"
)

// defaultMigrationsDir is where the local install's image keeps the SQL files.
const defaultMigrationsDir = "/migrations"

// dispatch runs the API, or the one command the image offers besides it. The image is distroless,
// so a job of the install can only call this binary.
func dispatch(ctx context.Context, args []string, lookup config.Lookup, stdout io.Writer, listen listenFunc) error {
	switch {
	case len(args) == 0:
		return run(ctx, lookup, stdout, listen)
	case args[0] == "migrate" && len(args) == 1:
		return runMigrate(ctx, lookup, stdout)
	}
	return fmt.Errorf("unknown command %q: run with no arguments to serve, or use `migrate`", args[0])
}

// runMigrate applies the pending migrations as the login the API serves with: that role owns the
// tables, which is what FORCE ROW LEVEL SECURITY and the automation cursors expect. A privileged
// login is refused here as well as at serving, or the tables would belong to it.
func runMigrate(ctx context.Context, lookup config.Lookup, stdout io.Writer) error {
	url, _ := lookup("SIPGES_DATABASE_URL")
	if url == "" {
		return errors.New("SIPGES_DATABASE_URL is required")
	}
	dir, ok := lookup("SIPGES_MIGRATIONS_DIR")
	if !ok {
		dir = defaultMigrationsDir
	}
	migrations, err := migrator.Load(os.DirFS(dir))
	if err != nil {
		return fmt.Errorf("no migrations in %s: %w", dir, err)
	}
	if len(migrations) == 0 {
		return fmt.Errorf("no migrations in %s", dir)
	}
	allowPrivileged, err := privilegedOverride(lookup)
	if err != nil {
		return err
	}
	pool, err := database.OpenForServing(ctx, url, allowPrivileged)
	if err != nil {
		return migrateFailure(err)
	}
	defer pool.Close()
	conn, err := pool.Acquire(ctx)
	if err != nil {
		return migrateFailure(err)
	}
	defer conn.Release()
	applied, err := migrator.Migrate(ctx, conn.Conn(), migrations)
	if err != nil {
		return migrateFailure(err)
	}
	if len(applied) == 0 {
		_, err = fmt.Fprintf(stdout, "Database up to date (%d migrations known)\n", len(migrations))
		return err
	}
	_, err = fmt.Fprintf(stdout, "Applied %d migration(s), latest %s\n", len(applied), applied[len(applied)-1])
	return err
}

// privilegedOverride is config.Load's switch; the rest of the configuration is not needed here.
func privilegedOverride(lookup config.Lookup) (bool, error) {
	v, ok := lookup("SIPGES_ALLOW_PRIVILEGED_DB_ROLE")
	if !ok {
		return false, nil
	}
	if v != "0" && v != "1" {
		return false, errors.New("SIPGES_ALLOW_PRIVILEGED_DB_ROLE must be unset or exactly '0' or '1'")
	}
	return v == "1", nil
}

// migrateFailure keeps PostgreSQL's own report, which names the statement's problem, and drops any
// other driver text: a connection error may quote the URL.
func migrateFailure(err error) error {
	if errors.Is(err, database.ErrPrivilegedRole) || errors.Is(err, database.ErrOverrideNotLoopback) {
		return err
	}
	var pg *pgconn.PgError
	if errors.As(err, &pg) {
		return fmt.Errorf("%s: %s (SQLSTATE %s)", failedVersion(err), pg.Message, pg.Code)
	}
	return errors.New("the database could not be reached")
}

// failedVersion is the migration the error names, or a general label before any file ran.
func failedVersion(err error) string {
	var failed *migrator.FailedError
	if errors.As(err, &failed) {
		return "migration " + failed.Version + " failed"
	}
	return "migration failed"
}
