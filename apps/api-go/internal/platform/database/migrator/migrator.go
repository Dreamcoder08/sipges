// Package migrator applies the SQL files of apps/api/src/platform/database/migrations with the
// semantics of migrator.ts: one transaction per file under an advisory lock, a re-check inside the
// lock, and the applied versions returned. A host without TypeScript runs it through `api migrate`.
package migrator

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"regexp"
	"slices"
	"strings"

	"github.com/jackc/pgx/v5"
)

// lockKey is MIGRATION_LOCK_KEY of migrator.ts, so both migrators serialize.
const lockKey int64 = 7_361_524_002

var migrationFile = regexp.MustCompile(`^\d{4}_[a-z0-9_]+\.sql$`)

// Migration is one versioned SQL file.
type Migration struct {
	Version string
	SQL     string
}

// FailedError names the file that stopped the run; the ones before it stay applied.
type FailedError struct {
	Version string
	Err     error
}

func (e *FailedError) Error() string { return fmt.Sprintf("migration %s failed: %v", e.Version, e.Err) }

// Unwrap returns the driver's error.
func (e *FailedError) Unwrap() error { return e.Err }

// Load reads `NNNN_name.sql` files from fsys, sorted by version.
func Load(fsys fs.FS) ([]Migration, error) {
	entries, err := fs.ReadDir(fsys, ".")
	if err != nil {
		return nil, fmt.Errorf("read migrations: %w", err)
	}
	var migrations []Migration
	for _, entry := range entries {
		if entry.IsDir() || !migrationFile.MatchString(entry.Name()) {
			continue
		}
		body, err := fs.ReadFile(fsys, entry.Name())
		if err != nil {
			return nil, fmt.Errorf("read migration %s: %w", entry.Name(), err)
		}
		migrations = append(migrations, Migration{Version: strings.TrimSuffix(entry.Name(), ".sql"), SQL: string(body)})
	}
	slices.SortFunc(migrations, func(a, b Migration) int { return strings.Compare(a.Version, b.Version) })
	return migrations, nil
}

// Migrate applies the pending migrations and returns the versions it applied.
func Migrate(ctx context.Context, conn *pgx.Conn, migrations []Migration) ([]string, error) {
	for i := 1; i < len(migrations); i++ {
		if migrations[i].Version <= migrations[i-1].Version {
			return nil, errors.New("migrations must be sorted by version")
		}
	}
	err := pgx.BeginFunc(ctx, conn, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock($1)", lockKey); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, "CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())")
		return err
	})
	if err != nil {
		return nil, fmt.Errorf("create schema_migrations: %w", err)
	}
	var applied []string
	for _, m := range migrations {
		ran := false
		err := pgx.BeginFunc(ctx, conn, func(tx pgx.Tx) error {
			if _, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock($1)", lockKey); err != nil {
				return err
			}
			var done bool
			if err := tx.QueryRow(ctx, "SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE version = $1)", m.Version).Scan(&done); err != nil {
				return err
			}
			if done {
				return nil
			}
			// No arguments: pgx sends it with the simple protocol, so a file may hold many statements.
			if _, err := tx.Exec(ctx, m.SQL); err != nil {
				return err
			}
			if _, err := tx.Exec(ctx, "INSERT INTO schema_migrations (version) VALUES ($1)", m.Version); err != nil {
				return err
			}
			ran = true
			return nil
		})
		if err != nil {
			return nil, &FailedError{Version: m.Version, Err: err}
		}
		if ran {
			applied = append(applied, m.Version)
		}
	}
	return applied, nil
}
