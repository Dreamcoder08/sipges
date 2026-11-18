package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/database/dbtest"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/localpg/pgbin"
)

// goFixture is a managed install whose versions carry the real Go mode: go/api built from cmd/api
// and go/migrations, as the builder's --go lays them out. PostgreSQL comes from --pg-bin.
func goFixture(t *testing.T) *fixture {
	t.Helper()
	api := buildAPI(t)
	apiBytes, err := os.ReadFile(api)
	if err != nil {
		t.Fatal(err)
	}
	migrations := dbtest.MigrationsDir()
	return newFixtureWith(t, func(pkg, _ string) {
		target := filepath.Join(pkg, "go", program("api"))
		mkdir(t, filepath.Dir(target))
		if err := os.WriteFile(target, apiBytes, 0o700); err != nil {
			t.Fatal(err)
		}
		err := filepath.WalkDir(migrations, func(path string, d fs.DirEntry, err error) error {
			if err != nil || d.IsDir() {
				return err
			}
			rel, _ := filepath.Rel(migrations, path)
			data, err := os.ReadFile(path)
			if err != nil {
				return err
			}
			put(t, filepath.Join(pkg, "go", "migrations", rel), string(data))
			return nil
		})
		if err != nil {
			t.Fatal(err)
		}
	})
}

// --prepare-only, then the first start over that cluster (a dated copy, a rehearsal on its own
// cluster and port, then the real folder), serving, a click update with the real boot check and
// the restart on the same port, then a stop that leaves PostgreSQL stopped.
func TestManagedLauncherPreparesStartsUpdatesAndRestartsOnPostgres18(t *testing.T) {
	bin := pgbin.ForTest(t)
	f := goFixture(t)
	put(t, filepath.Join(f.state, "data-key"), "c3ludGhldGljLWRhdGEta2V5LTMyLWJ5dGVzLXh4eHg=\n")
	put(t, filepath.Join(f.state, "admin-password"), "SyntheticAdmin-2026\n")
	ctx := context.Background()
	env := []string{"PATH=" + os.Getenv("PATH"), "SIPGES_DATABASE_URL=postgres://inherited.invalid/x"}

	var out, errOut bytes.Buffer
	if code := runLauncherCLI(ctx, []string{"--install", f.root, "--prepare-only", "--pg-bin", bin}, env, &out, &errOut, nil); code != 0 {
		t.Fatalf("--prepare-only: exit %d\n%s\n%s", code, out.String(), errOut.String())
	}
	if _, err := os.Stat(filepath.Join(f.state, "pg18", "postmaster.pid")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("PostgreSQL still running after --prepare-only: %v", err)
	}
	sec, err := readSecrets(f.state)
	if err != nil {
		t.Fatal(err)
	}
	pg, err := startCluster(ctx, bin, f.state, sec)
	if err != nil {
		t.Fatal(err)
	}
	// What pglite-to-postgres.mjs fills: the roles and an empty database, no migration applied.
	assertEmptyAppDatabase(t, f.state)
	if err := stopCluster(ctx, pg); err != nil {
		t.Fatal(err)
	}
	out.Reset()
	errOut.Reset()
	if code := runLauncherCLI(ctx, []string{"--install", f.root, "--prepare-only", "--pg-bin", bin}, env, &out, &errOut, nil); code != 1 ||
		!strings.Contains(errOut.String(), "ya tiene una base de datos PostgreSQL 18") {
		t.Fatalf("a second --prepare-only: exit %d\n%s", code, errOut.String())
	}

	f.release("1.1.0", releaseOptions{notes: strp("Sintético.")})
	port := freePort(t)
	runCtx, stop := context.WithCancel(ctx)
	defer stop()
	logs := &lockedBuffer{}
	done := make(chan int, 1)
	go func() {
		done <- runLauncherCLI(runCtx, []string{"--install", f.root, "--releases", f.source, "--port", strconv.Itoa(port), "--pg-bin", bin},
			env, logs, logs, nil)
	}()
	waitHealthCode(t, port, done)
	events := func() []map[string]any { return eventsIn(logs.String()) }
	waitFor(t, "update_check", events)
	first := findEvent(events(), "first_start")
	if first == nil || !strings.Contains(first["preUpdateCopy"].(string), "state.pre-update-") {
		t.Fatalf("no first start over the prepared cluster: %v", first)
	}
	assertAppRole(t, f.state)

	f.request("1.1.0")
	waitFor(t, "updated", events)
	restarted := waitForN(t, "started", 2, events)
	if restarted["version"] != "1.1.0" || restarted["port"] != float64(port) {
		t.Fatalf("restart %v", restarted)
	}
	waitHealthCode(t, port, done)
	if f.current() != "1.1.0" {
		t.Fatalf("current %s", f.current())
	}
	stop()
	select {
	case code := <-done:
		if code != 0 {
			t.Fatalf("exit %d\n%s", code, logs.String())
		}
	case <-time.After(2 * time.Minute):
		t.Fatal("the launcher did not stop")
	}
	if _, err := os.Stat(filepath.Join(f.state, "pg18", "postmaster.pid")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("PostgreSQL still running after the launcher stopped: %v", err)
	}
	var names []string
	for _, e := range events() {
		names = append(names, e["event"].(string))
	}
	t.Logf("events: %v", names)
	if boot, err := os.ReadFile(filepath.Join(f.root, "update-boot.log")); err != nil || len(boot) == 0 {
		t.Fatalf("update-boot.log: %v", err)
	}
}

func waitHealthCode(t *testing.T, port int, done chan int) {
	t.Helper()
	errs := make(chan error, 1)
	go func() {
		if code, ok := <-done; ok {
			done <- code
			errs <- errors.New("ended with " + strconv.Itoa(code))
		}
	}()
	waitHealth(t, port, errs)
}

func eventsIn(text string) []map[string]any {
	var out []map[string]any
	for _, line := range strings.Split(text, "\n") {
		var m map[string]any
		// The API's own JSON log lines carry no "event": only the launcher's lines count.
		if strings.HasPrefix(line, `{"time":`) && json.Unmarshal([]byte(line), &m) == nil && m["event"] != nil {
			out = append(out, m)
		}
	}
	return out
}

func findEvent(events []map[string]any, name string) map[string]any {
	for _, e := range events {
		if e["event"] == name {
			return e
		}
	}
	return nil
}

func waitFor(t *testing.T, name string, events func() []map[string]any) {
	t.Helper()
	waitForN(t, name, 1, events)
}

func waitForN(t *testing.T, name string, n int, events func() []map[string]any) map[string]any {
	t.Helper()
	deadline := time.Now().Add(3 * time.Minute)
	for time.Now().Before(deadline) {
		seen := 0
		for _, e := range events() {
			if e["event"] == name {
				if seen++; seen == n {
					return e
				}
			}
			if e["event"] == "update_failed" || e["event"] == "start_failed" || e["event"] == "start_refused" {
				t.Fatalf("%v", e)
			}
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatalf("no %d× %s: %v", n, name, events())
	return nil
}

// A2: --prepare-only that fails after building the cluster removes the half-provisioned pg18, so
// the next attempt is not refused as «already holds data».
func TestAFailedPrepareOnlyRemovesTheHalfMadeCluster(t *testing.T) {
	bin := pgbin.ForTest(t)
	state := t.TempDir()
	put(t, filepath.Join(state, "data-key"), "c3ludGhldGljLWRhdGEta2V5LTMyLWJ5dGVzLXh4eHg=\n")
	put(t, filepath.Join(state, "admin-password"), "SyntheticAdmin-2026\n")
	failing := errors.New("synthetic check failure after the cluster was made")
	saved := prepareCheck
	prepareCheck = func(context.Context, string) error { return failing }
	t.Cleanup(func() { prepareCheck = saved })
	err := run(context.Background(), []string{"--state", state, "--pg-bin", bin, "--prepare-only"},
		[]string{"PATH=" + os.Getenv("PATH")}, io.Discard, io.Discard)
	if !errors.Is(err, failing) {
		t.Fatalf("--prepare-only with a failing check: %v", err)
	}
	if _, statErr := os.Stat(filepath.Join(state, "pg18")); !errors.Is(statErr, os.ErrNotExist) {
		t.Fatalf("the half-made cluster is still there: %v (%v)", statErr, err)
	}
	if msg := userMessage(err); !strings.Contains(msg, "se borró la carpeta pg18 a medio preparar") || !strings.Contains(msg, failing.Error()) {
		t.Fatalf("message %q", msg)
	}
}

// --prepare-only runs no `api migrate`: an API binary that is missing changes nothing.
func TestPrepareOnlyLeavesAnEmptyDatabaseWithoutTheAPI(t *testing.T) {
	bin := pgbin.ForTest(t)
	state := t.TempDir()
	put(t, filepath.Join(state, "data-key"), "c3ludGhldGljLWRhdGEta2V5LTMyLWJ5dGVzLXh4eHg=\n")
	put(t, filepath.Join(state, "admin-password"), "SyntheticAdmin-2026\n")
	var out bytes.Buffer
	if err := run(context.Background(), []string{"--state", state, "--pg-bin", bin, "--api", filepath.Join(t.TempDir(), program("api")), "--prepare-only"},
		[]string{"PATH=" + os.Getenv("PATH")}, &out, io.Discard); err != nil {
		t.Fatalf("--prepare-only: %v", err)
	}
	if !strings.Contains(out.String(), "sipges-desktop: PostgreSQL 18 prepared in "+filepath.Join(state, "pg18")) {
		t.Fatalf("stdout %q", out.String())
	}
	if _, err := os.Stat(filepath.Join(state, "pg18", "postmaster.pid")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("PostgreSQL still running after --prepare-only: %v", err)
	}
	sec, err := readSecrets(state)
	if err != nil {
		t.Fatal(err)
	}
	pg, err := startCluster(context.Background(), bin, state, sec)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = stopCluster(context.Background(), pg) }()
	assertEmptyAppDatabase(t, state)
}

// assertEmptyAppDatabase: the non-privileged login owns the application database, which holds no
// table (no schema_migrations either): what the one-time PGlite move accepts.
func assertEmptyAppDatabase(t *testing.T, state string) {
	t.Helper()
	sec, err := readSecrets(state)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	pidFile, err := os.ReadFile(filepath.Join(state, "pg18", "postmaster.pid"))
	if err != nil {
		t.Fatal(err)
	}
	conn, err := pgx.Connect(ctx, "postgres://"+appRole+":"+sec.pgApp+"@127.0.0.1:"+lineOf(string(pidFile), 3)+"/"+appDatabase+"?sslmode=disable")
	if err != nil {
		t.Fatalf("connect as %s: %v", appRole, err)
	}
	defer func() { _ = conn.Close(ctx) }()
	var owner string
	var super, tables, migrations int
	if err := conn.QueryRow(ctx, `SELECT pg_get_userbyid(datdba), (SELECT count(*) FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)),
		(SELECT count(*) FROM pg_tables WHERE schemaname = 'public'), (SELECT count(*) FROM pg_class WHERE relname = 'schema_migrations')
		FROM pg_database WHERE datname = current_database()`).Scan(&owner, &super, &tables, &migrations); err != nil {
		t.Fatal(err)
	}
	if owner != appRole || super != 0 || tables != 0 || migrations != 0 {
		t.Fatalf("owner %s, privileged %d, public tables %d, schema_migrations %d", owner, super, tables, migrations)
	}
}
