// Package dbtest creates a scratch PostgreSQL database with the SIPGES schema for integration
// tests. It is imported only by tests: the TypeScript API stays the one migrator in production
// (docs/adr/0032 §5), so this port applies the same files under the same advisory lock.
package dbtest

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"slices"
	"strings"

	"github.com/jackc/pgx/v5"
)

// EnvAdminURL names the connection string of a synthetic server where tests may create and
// drop databases; the TypeScript integration tests read the same variable.
const EnvAdminURL = "SIPGES_TEST_DATABASE_URL"

// migrationLockKey is the pg_advisory_xact_lock key shared with
// apps/api/src/platform/database/migrator.ts, so both migrators serialize.
const migrationLockKey int64 = 7_361_524_002

var migrationFile = regexp.MustCompile(`^\d{4}_[a-z0-9_]+\.sql$`)

// Migration is one versioned SQL file.
type Migration struct {
	Version string
	SQL     string
}

// Scratch is a database created for one test run.
type Scratch struct {
	// URL connects to the scratch database as the admin user.
	URL   string
	Name  string
	admin string
}

// MigrationsDir is apps/api/src/platform/database/migrations, resolved from this file so it
// works from any package directory.
func MigrationsDir() string {
	_, file, _, _ := runtime.Caller(0)
	return filepath.Join(filepath.Dir(file), "..", "..", "..", "..", "..", "api", "src", "platform", "database", "migrations")
}

// LoadMigrations reads `NNNN_name.sql` files from fsys, sorted by version.
func LoadMigrations(fsys fs.FS) ([]Migration, error) {
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

// Migrate applies the pending migrations, each in its own transaction, with the semantics of
// migrator.ts: an advisory lock, a re-check inside the lock, and the applied versions returned.
func Migrate(ctx context.Context, conn *pgx.Conn, migrations []Migration) ([]string, error) {
	for i := 1; i < len(migrations); i++ {
		if migrations[i].Version <= migrations[i-1].Version {
			return nil, errors.New("migrations must be sorted by version")
		}
	}
	err := pgx.BeginFunc(ctx, conn, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock($1)", migrationLockKey); err != nil {
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
			if _, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock($1)", migrationLockKey); err != nil {
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
			return nil, fmt.Errorf("migration %s failed: %w", m.Version, err)
		}
		if ran {
			applied = append(applied, m.Version)
		}
	}
	return applied, nil
}

// NewScratch creates an empty database named sipges_go_test_<random> on the admin server and
// applies every migration to it.
func NewScratch(ctx context.Context, adminURL string) (*Scratch, error) {
	suffix := make([]byte, 6)
	if _, err := rand.Read(suffix); err != nil {
		return nil, fmt.Errorf("random database name: %w", err)
	}
	name := "sipges_go_test_" + hex.EncodeToString(suffix)
	if err := adminExec(ctx, adminURL, "CREATE DATABASE "+name); err != nil {
		return nil, fmt.Errorf("create scratch database: %w", err)
	}
	scratch := &Scratch{Name: name, admin: adminURL}
	parsed, err := url.Parse(adminURL)
	if err != nil {
		return nil, errors.Join(errors.New("parse admin URL"), scratch.Drop(ctx))
	}
	parsed.Path = "/" + name
	scratch.URL = parsed.String()

	migrations, err := LoadMigrations(os.DirFS(MigrationsDir()))
	if err != nil {
		return nil, errors.Join(err, scratch.Drop(ctx))
	}
	if len(migrations) == 0 {
		return nil, errors.Join(errors.New("no migrations found in "+MigrationsDir()), scratch.Drop(ctx))
	}
	// Migrations create and rename roles, which are cluster-wide: test packages running in
	// parallel (go test ./...) migrate one at a time, under a lock on the shared admin database.
	lock, err := pgx.Connect(ctx, adminURL)
	if err != nil {
		return nil, errors.Join(fmt.Errorf("connect admin database: %w", err), scratch.Drop(ctx))
	}
	defer func() { _ = lock.Close(context.WithoutCancel(ctx)) }() // closing releases the lock
	if _, err := lock.Exec(ctx, "SELECT pg_advisory_lock($1)", scratchLockKey); err != nil {
		return nil, errors.Join(fmt.Errorf("lock migrations: %w", err), scratch.Drop(ctx))
	}
	conn, err := pgx.Connect(ctx, scratch.URL)
	if err != nil {
		return nil, errors.Join(fmt.Errorf("connect scratch database: %w", err), scratch.Drop(ctx))
	}
	defer func() { _ = conn.Close(ctx) }()
	if _, err := Migrate(ctx, conn, migrations); err != nil {
		return nil, errors.Join(err, scratch.Drop(ctx))
	}
	return scratch, nil
}

// scratchLockKey serializes scratch migrations across databases of one server. migrationLockKey
// cannot: an advisory lock is per database, and each scratch migration runs in its own.
const scratchLockKey int64 = 0x5349504745530001

// URLAs returns the scratch database URL for another login.
func (s *Scratch) URLAs(user, password string) string {
	parsed, _ := url.Parse(s.URL)
	parsed.User = url.UserPassword(user, password)
	return parsed.String()
}

// AdminExec runs one statement on the admin server (roles are cluster-wide).
func (s *Scratch) AdminExec(ctx context.Context, sql string) error {
	return adminExec(ctx, s.admin, sql)
}

// Drop removes the scratch database, closing any connection still open to it.
func (s *Scratch) Drop(ctx context.Context) error {
	return adminExec(ctx, s.admin, "DROP DATABASE IF EXISTS "+s.Name+" WITH (FORCE)")
}

func adminExec(ctx context.Context, adminURL, sql string) error {
	conn, err := pgx.Connect(ctx, adminURL)
	if err != nil {
		return fmt.Errorf("connect admin database: %w", err)
	}
	defer func() { _ = conn.Close(ctx) }()
	if _, err := conn.Exec(ctx, sql); err != nil {
		return fmt.Errorf("admin statement: %w", err)
	}
	return nil
}
