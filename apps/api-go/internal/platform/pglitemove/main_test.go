package pglitemove

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/localpg"
)

// secret is the marker every synthetic text value of testdata/make-state.mjs carries.
const secret = "ZZSECRET"

var (
	shared struct {
		dir string // removed after the run

		templateOnce sync.Once
		template     string
		templateErr  error

		pgOnce sync.Once
		pg     *localpg.Server
		pgBin  string
		pgErr  error
	}
)

func TestMain(m *testing.M) {
	dir, err := os.MkdirTemp("", "sipges-pglitemove-test-")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	shared.dir = dir
	code := m.Run()
	if shared.pg != nil {
		ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
		if err := shared.pg.Stop(ctx); err != nil {
			fmt.Fprintln(os.Stderr, "stop PostgreSQL 18:", err)
			code = 1
		}
		cancel()
	}
	_ = os.RemoveAll(dir)
	os.Exit(code)
}

// distDir is the pinned PGlite dist folder; without SIPGES_PGLITE_DIST the test skips.
func distDir(t *testing.T) string {
	t.Helper()
	dir := os.Getenv("SIPGES_PGLITE_DIST")
	if dir == "" {
		t.Skip("SIPGES_PGLITE_DIST is not set: point it at the dist folder of @electric-sql/pglite 0.5.15")
	}
	return dir
}

// template is a synthetic state folder made by PGlite 0.5.15 itself with Node, once per run
// (testdata/make-state.mjs). Test setup only: the move never runs Node.
func template(t *testing.T) string {
	t.Helper()
	dist := distDir(t)
	shared.templateOnce.Do(func() {
		node, err := exec.LookPath("node")
		if err != nil {
			shared.templateErr = fmt.Errorf("skip: node is not on PATH to make the synthetic PGlite folder")
			return
		}
		state := filepath.Join(shared.dir, "template")
		cmd := exec.Command(node, filepath.Join("testdata", "make-state.mjs"), dist, state)
		if out, err := cmd.CombinedOutput(); err != nil {
			shared.templateErr = fmt.Errorf("make-state.mjs: %w\n%s", err, out)
			return
		}
		shared.template = state
	})
	if shared.templateErr != nil {
		if strings.HasPrefix(shared.templateErr.Error(), "skip: ") {
			t.Skip(strings.TrimPrefix(shared.templateErr.Error(), "skip: "))
		}
		t.Fatal(shared.templateErr)
	}
	return shared.template
}

// copyOf is a copy of the template, the way the owner copies the state folder before the move.
func copyOf(t *testing.T) string {
	t.Helper()
	src := template(t)
	dst := filepath.Join(t.TempDir(), "copy")
	if err := os.Mkdir(dst, 0o700); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"pglite", "uploads"} {
		if err := copyTree(filepath.Join(src, name), filepath.Join(dst, name)); err != nil {
			t.Fatal(err)
		}
	}
	for _, name := range []string{"data-key", "admin-password"} {
		data, err := os.ReadFile(filepath.Join(src, name))
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dst, name), data, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	return dst
}

// pgBinDir is a PostgreSQL 18 bin folder: SIPGES_PG_BIN, else the one holding pg_dump on PATH.
func pgBinDir(t *testing.T) string {
	t.Helper()
	dir := os.Getenv("SIPGES_PG_BIN")
	if dir == "" {
		p, err := exec.LookPath("pg_dump")
		if err != nil {
			t.Skip("no PostgreSQL 18: pg_dump is not on PATH and SIPGES_PG_BIN is not set")
		}
		dir = filepath.Dir(p)
	}
	out, err := exec.Command(filepath.Join(dir, exe("pg_dump")), "--version").Output()
	if err != nil || !strings.Contains(string(out), " 18.") {
		t.Skipf("no PostgreSQL 18 in %s: %s", dir, out)
	}
	for _, name := range []string{"initdb", "pg_ctl", "postgres"} {
		if _, err := os.Stat(filepath.Join(dir, exe(name))); err != nil {
			t.Skipf("%s is not in %s", name, dir)
		}
	}
	return dir
}

// server is one throwaway PostgreSQL 18 for the whole run, stopped in TestMain.
func server(t *testing.T) *localpg.Server {
	t.Helper()
	bin := pgBinDir(t)
	shared.pgOnce.Do(func() {
		shared.pgBin = bin
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
		defer cancel()
		shared.pg, shared.pgErr = localpg.Start(ctx, localpg.Options{
			BinDir:        bin,
			DataDir:       filepath.Join(shared.dir, "pg18"),
			LogPath:       filepath.Join(shared.dir, "pg18.log"),
			SuperUser:     "postgres",
			SuperPassword: "synthetic-test-only",
		})
	})
	if shared.pgErr != nil {
		t.Fatalf("start PostgreSQL 18: %v", shared.pgErr)
	}
	return shared.pg
}

func adminExec(t *testing.T, database string, sqls ...string) {
	t.Helper()
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, server(t).SuperUserURL(database))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = conn.Close(ctx) }()
	for _, sql := range sqls {
		if _, err := conn.Exec(ctx, sql); err != nil {
			t.Fatalf("%s: %v", sql, err)
		}
	}
}

// target is a fresh database owned by a fresh login that is not a superuser, as the desktop
// launcher prepares it for the Go API, with the tenant role granted to it. Dropped at the end.
func target(t *testing.T) (url, password string) {
	t.Helper()
	srv := server(t)
	b := make([]byte, 4)
	_, _ = rand.Read(b)
	id := hex.EncodeToString(b)
	name := "sipges_move_" + id
	pw := make([]byte, 12)
	_, _ = rand.Read(pw)
	password = hex.EncodeToString(pw)
	adminExec(t, "postgres",
		fmt.Sprintf("CREATE ROLE %s LOGIN PASSWORD '%s'", name, password),
		fmt.Sprintf("CREATE DATABASE %s OWNER %s", name, name),
		`DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'sipges_tenant') THEN
		   CREATE ROLE sipges_tenant NOLOGIN NOINHERIT; END IF; END $$`,
		fmt.Sprintf("GRANT sipges_tenant TO %s", name),
	)
	t.Cleanup(func() {
		adminExec(t, "postgres",
			fmt.Sprintf("DROP DATABASE IF EXISTS %s WITH (FORCE)", name),
			fmt.Sprintf("DROP OWNED BY %s", name),
			fmt.Sprintf("DROP ROLE IF EXISTS %s", name))
	})
	return srv.URL(name, password, name), password
}

// tableCount is how many tables the target's public schema holds.
func tableCount(t *testing.T, url string) int {
	t.Helper()
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = conn.Close(ctx) }()
	var n int
	if err := conn.QueryRow(ctx, `SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
	  WHERE n.nspname = 'public' AND c.relkind = 'r'`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

// move runs the move in process with SIPGES never answering and an original folder under the
// test's own temp folder.
func move(t *testing.T, o Options, h Hooks) (int, string) {
	t.Helper()
	if o.PGliteDist == "" {
		o.PGliteDist = distDir(t)
	}
	if o.PGBin == "" {
		o.PGBin = pgBinDir(t)
	}
	if o.Originals == nil {
		o.Originals = []string{filepath.Join(t.TempDir(), "home", ".local", "share", "sipges-local")}
	}
	if h.Answers == nil {
		h.Answers = func(int) bool { return false }
	}
	var out strings.Builder
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	code := Run(ctx, o, &out, h)
	return code, out.String()
}

func noLeak(t *testing.T, out string, extra ...string) {
	t.Helper()
	for _, s := range append([]string{secret}, extra...) {
		if s != "" && strings.Contains(out, s) {
			t.Fatalf("the output holds a value it must never print (%q):\n%s", s, out)
		}
	}
}

func digest(t *testing.T, dir string) string {
	t.Helper()
	d, err := treeDigest(dir)
	if err != nil {
		t.Fatal(err)
	}
	return d
}
