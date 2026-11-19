package pglitemove

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/pglitewasm"
)

// session is what both sides are read with, so every value prints the same text.
var session = [][2]string{{"TimeZone", "UTC"}, {"DateStyle", "ISO, MDY"}, {"IntervalStyle", "postgres"}}

// tools are the checked PGlite dist folder and pg_dump.
type tools struct {
	dist          string
	pgDump        string
	pgDumpVersion string
}

func exe(name string) string {
	if runtime.GOOS == "windows" {
		return name + ".exe"
	}
	return name
}

// loadTools refuses a PGlite dist folder that is not the pinned 0.5.15 one and a pg_dump that is
// not PostgreSQL 18 (pglite-to-postgres.mjs loadTools refuses an unpinned PGlite).
func loadTools(ctx context.Context, o Options) (tools, error) {
	if o.PGliteDist == "" {
		return tools{}, refusef("the PGlite %s dist folder is required: --pglite-dist, or run the sipges-desktop of a managed install that ships it", PGliteVersion)
	}
	if err := pglitewasm.CheckDist(o.PGliteDist); err != nil {
		return tools{}, refusef("--pglite-dist %s is not the pinned @electric-sql/pglite %s dist folder: %v", o.PGliteDist, PGliteVersion, err)
	}
	if o.PGBin == "" {
		return tools{}, refusef("the PostgreSQL 18 bin folder (pg_dump) is required: --pg-bin or SIPGES_PG_BIN, or run the sipges-desktop of a managed install")
	}
	pgDump := filepath.Join(o.PGBin, exe("pg_dump"))
	vctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(vctx, pgDump, "--version") //nolint:gosec // the pg_dump of the given PostgreSQL bin folder
	cmd.Env = dumpEnv()
	out, err := cmd.Output()
	version := strings.TrimSpace(string(out))
	if err != nil || !strings.HasPrefix(version, "pg_dump (PostgreSQL) 18.") {
		return tools{}, refusef("no pg_dump of PostgreSQL 18 in --pg-bin %s", o.PGBin)
	}
	return tools{dist: o.PGliteDist, pgDump: pgDump, pgDumpVersion: version}, nil
}

// dumpEnv is the environment pg_dump runs with: no PG* variable of the caller (a PGSERVICE or
// PGOPTIONS must not change what it reads), a bounded connect.
func dumpEnv() []string {
	var env []string
	for _, kv := range os.Environ() {
		if !strings.HasPrefix(strings.ToUpper(kv), "PG") {
			env = append(env, kv)
		}
	}
	return append(env, "PGCONNECT_TIMEOUT=30")
}

// source is what the copy yields.
type source struct {
	version string
	dump    string
	tables  *database
	catalog map[string]string
	roles   []sourceRole
}

// readSource copies the pglite folder to scratch, opens and serves only that copy, dumps and
// reads it, and removes the copy. The run removes it, never a signal: every step under work has
// ended by then.
func readSource(ctx context.Context, t tools, db, scratchRoot string, stop *Stop) (*source, error) {
	if err := stop.checkpoint(); err != nil {
		return nil, err
	}
	work, err := os.MkdirTemp(scratchRoot, "sipges-pglite-move-")
	if err != nil {
		return nil, err
	}
	stop.set(func(s *Stop) { s.work = work })
	src, failure := readCopy(ctx, t, db, filepath.Join(work, "pglite"), stop)
	if !removeAll(work) {
		return nil, refusef("the scratch copy %s could not be removed: delete that folder", work)
	}
	stop.set(func(s *Stop) { s.work = "" })
	if failure != nil {
		return nil, failure
	}
	if err := stop.checkpoint(); err != nil {
		return nil, err
	}
	return src, nil
}

func readCopy(ctx context.Context, t tools, db, dir string, stop *Stop) (*source, error) {
	if err := copyTree(db, dir); err != nil {
		return nil, err
	}
	if err := stop.checkpoint(); err != nil {
		return nil, err
	}
	backend, err := pglitewasm.Open(ctx, t.dist, dir)
	if err != nil {
		// Never the error's text: it carries PostgreSQL's log.
		return nil, refusef("the scratch copy of the PGlite database could not be opened")
	}
	defer func() { _ = backend.Close(context.WithoutCancel(ctx)) }()
	srv, err := pglitewasm.Serve(ctx, backend)
	if err != nil {
		return nil, refusef("the scratch copy could not be served on loopback")
	}
	defer func() { _ = srv.Close() }()
	url := fmt.Sprintf("postgres://postgres@%s/postgres?sslmode=disable", srv.Addr())

	src := &source{}
	// Inside the scratch folder, which readSource removes with the copy.
	if src.dump, err = pgDump(ctx, t.pgDump, url, srv.Password(), filepath.Join(filepath.Dir(dir), "dump.sql")); err != nil {
		return nil, err
	}
	if err := stop.checkpoint(); err != nil {
		return nil, err
	}
	cfg, err := pgx.ParseConfig(url)
	if err != nil {
		return nil, err
	}
	cfg.DefaultQueryExecMode = pgx.QueryExecModeDescribeExec
	cfg.Password = srv.Password()
	conn, err := pgx.ConnectConfig(ctx, cfg)
	if err != nil {
		return nil, refusef("the scratch copy could not be read over loopback")
	}
	defer func() { _ = conn.Close(context.WithoutCancel(ctx)) }()
	if err := conn.QueryRow(ctx, "SHOW server_version_num").Scan(&src.version); err != nil {
		return nil, err
	}
	for _, kv := range session {
		if _, err := conn.Exec(ctx, fmt.Sprintf("SET %s = '%s'", kv[0], kv[1])); err != nil {
			return nil, err
		}
	}
	if src.tables, err = readDatabase(ctx, conn); err != nil {
		return nil, err
	}
	if src.catalog, err = readCatalog(ctx, conn); err != nil {
		return nil, err
	}
	if src.roles, err = readSourceRoles(ctx, conn); err != nil {
		return nil, err
	}
	return src, nil
}

// pgDump runs the native pg_dump 18 against the served copy, as pgDump of pglite-tools does
// (plain SQL, --inserts, -U postgres) with --no-owner: the tables must belong to the target
// login, the one the Go API serves with; grants are kept. pg_dump writes file (-f, never stdout:
// on Windows stdout is in text mode and LF would become CRLF, changing values), which is read
// and removed at once. pg_dump's own messages are never printed (they may quote the database).
func pgDump(ctx context.Context, pgDumpPath, url, password, file string) (string, error) {
	var out, errOut bytes.Buffer
	cmd := exec.CommandContext(ctx, pgDumpPath, "--no-owner", "--inserts", "-U", "postgres", "-f", file, "--dbname", url) //nolint:gosec // the checked pg_dump, against our loopback server
	// The loopback server's password goes in pg_dump's environment only, never on its command line.
	cmd.Env = append(dumpEnv(), "PGPASSWORD="+password)
	cmd.Stdout, cmd.Stderr = &out, &errOut
	err := cmd.Run()
	data, readErr := os.ReadFile(file) //nolint:gosec // our own file in the scratch folder
	if rmErr := os.Remove(file); rmErr != nil && !errors.Is(rmErr, os.ErrNotExist) {
		return "", refusef("the dump %s could not be removed: delete that file", file)
	}
	if err != nil {
		code := -1
		if cmd.ProcessState != nil {
			code = cmd.ProcessState.ExitCode()
		}
		return "", refusef("pg_dump could not dump the scratch copy (exit code %d)", code)
	}
	if readErr != nil {
		return "", refusef("pg_dump wrote no dump of the scratch copy")
	}
	return stripRestrict(string(data))
}

var (
	restrictRE   = regexp.MustCompile(`^\\restrict ([A-Za-z0-9]+)$`)
	unrestrictRE = regexp.MustCompile(`^\\unrestrict ([A-Za-z0-9]+)$`)
)

// stripRestrict removes the two psql meta-commands pg_dump 18.x wraps a plain dump in
// (`\restrict <key>` first, `\unrestrict <key>` last), which only psql understands and a server
// refuses. Exactly those: the first meta-command line and a matching last one; any other line
// starting with a backslash outside them stays and the restore refuses it.
func stripRestrict(dump string) (string, error) {
	lines := strings.Split(dump, "\n")
	first := -1
	for i, l := range lines {
		if strings.HasPrefix(l, `\`) {
			first = i
			break
		}
	}
	if first < 0 {
		return dump, nil
	}
	m := restrictRE.FindStringSubmatch(lines[first])
	if m == nil {
		return "", refusef("the dump holds a psql meta-command other than \\restrict: not restored")
	}
	last := len(lines) - 1
	for last > first && strings.TrimSpace(lines[last]) == "" {
		last--
	}
	n := unrestrictRE.FindStringSubmatch(lines[last])
	if n == nil || n[1] != m[1] {
		return "", refusef("the dump has \\restrict without its matching \\unrestrict: not restored")
	}
	kept := append(append(append([]string{}, lines[:first]...), lines[first+1:last]...), lines[last+1:]...)
	return strings.Join(kept, "\n"), nil
}
