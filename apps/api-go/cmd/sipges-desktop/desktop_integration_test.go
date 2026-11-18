package main

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/database/dbtest"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/localpg/pgbin"
)

// buildAPI compiles cmd/api, the binary the desktop runs, into a scratch folder.
func buildAPI(t *testing.T) string {
	t.Helper()
	gobin, err := exec.LookPath("go")
	if err != nil {
		t.Skip("the go tool is not on PATH: cannot build cmd/api for the end-to-end test")
	}
	out := filepath.Join(t.TempDir(), program("api"))
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	build := exec.CommandContext(ctx, gobin, "build", "-o", out, "../api")
	if msg, err := build.CombinedOutput(); err != nil {
		t.Fatalf("go build ../api: %v\n%s", err, msg)
	}
	return out
}

func freePort(t *testing.T) int {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = ln.Close() }()
	return ln.Addr().(*net.TCPAddr).Port
}

func TestDesktopBootsServesHealthAndStopsPostgres(t *testing.T) {
	bin := pgbin.ForTest(t)
	api := buildAPI(t)
	state := t.TempDir()
	writeFile(t, filepath.Join(state, "data-key"), "c3ludGhldGljLWRhdGEta2V5LTMyLWJ5dGVzLXh4eHg=\n")
	writeFile(t, filepath.Join(state, "admin-password"), "SyntheticAdmin-2026\n")
	port := freePort(t)
	args := []string{
		"--state", state, "--pg-bin", bin, "--api", api,
		"--migrations", dbtest.MigrationsDir(), "--port", strconv.Itoa(port),
	}

	boot := func() (cancel func(), done chan error) {
		ctx, cancel := context.WithCancel(context.Background())
		done = make(chan error, 1)
		go func() { done <- run(ctx, args, []string{"PATH=" + os.Getenv("PATH")}, io.Discard, io.Discard) }()
		waitHealth(t, port, done)
		return cancel, done
	}

	cancel, done := boot()
	assertAppRole(t, state)
	cancel()
	waitStopped(t, state, done)

	// A second boot reuses the cluster: initdb and the roles are not redone, and nothing fails.
	cancel, done = boot()
	cancel()
	waitStopped(t, state, done)
}

func waitHealth(t *testing.T, port int, done chan error) {
	t.Helper()
	url := "http://127.0.0.1:" + strconv.Itoa(port) + "/health"
	deadline := time.Now().Add(2 * time.Minute)
	for time.Now().Before(deadline) {
		select {
		case err := <-done:
			t.Fatalf("sipges-desktop ended before /health answered: %v", err)
		default:
		}
		req, _ := http.NewRequestWithContext(context.Background(), http.MethodGet, url, http.NoBody)
		res, err := http.DefaultClient.Do(req)
		if err == nil {
			_ = res.Body.Close()
			if res.StatusCode == http.StatusOK {
				return
			}
		}
		time.Sleep(250 * time.Millisecond)
	}
	t.Fatalf("GET %s never answered 200", url)
}

func waitStopped(t *testing.T, state string, done chan error) {
	t.Helper()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("run after a stop request: %v", err)
		}
	case <-time.After(90 * time.Second):
		t.Fatal("sipges-desktop did not stop")
	}
	if _, err := os.Stat(filepath.Join(state, "pg18", "postmaster.pid")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("PostgreSQL still running after the desktop stopped: %v", err)
	}
}

// assertAppRole proves the API serves as the non-privileged owner the local install uses.
func assertAppRole(t *testing.T, state string) {
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
	pgPort := lineOf(string(pidFile), 3)
	conn, err := pgx.Connect(ctx, "postgres://"+appRole+":"+sec.pgApp+"@127.0.0.1:"+pgPort+"/"+appDatabase+"?sslmode=disable")
	if err != nil {
		t.Fatalf("connect as %s: %v", appRole, err)
	}
	defer func() { _ = conn.Close(ctx) }()
	var super, bypass bool
	var migrations int
	if err := conn.QueryRow(ctx, "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user").Scan(&super, &bypass); err != nil {
		t.Fatal(err)
	}
	if super || bypass {
		t.Fatalf("%s is superuser=%v bypassrls=%v", appRole, super, bypass)
	}
	if err := conn.QueryRow(ctx, "SELECT count(*) FROM schema_migrations").Scan(&migrations); err != nil || migrations == 0 {
		t.Fatalf("migrations applied: %d, %v", migrations, err)
	}
}

// lineOf returns line index (0-based) of postmaster.pid; index 3 is the port.
func lineOf(body string, index int) string {
	lines := strings.Split(body, "\n")
	if index >= len(lines) {
		return ""
	}
	return strings.TrimSpace(lines[index])
}

// An API that exits by itself ends the desktop with an error, and PostgreSQL still stops.
func TestDesktopStopsPostgresWhenTheAPIExits(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("uses /bin/true as an API that exits at once")
	}
	bin := pgbin.ForTest(t)
	state := t.TempDir()
	writeFile(t, filepath.Join(state, "data-key"), "c3ludGhldGljLWRhdGEta2V5LTMyLWJ5dGVzLXh4eHg=\n")
	writeFile(t, filepath.Join(state, "admin-password"), "SyntheticAdmin-2026\n")
	args := []string{"--state", state, "--pg-bin", bin, "--api", "/bin/true", "--migrations", t.TempDir()}
	err := run(context.Background(), args, nil, io.Discard, io.Discard)
	if err == nil || !strings.Contains(userMessage(err), "El servidor de SIPGES se detuvo") {
		t.Fatalf("run = %v (%q), want the API-exited error", err, userMessage(err))
	}
	if _, err := os.Stat(filepath.Join(state, "pg18", "postmaster.pid")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("PostgreSQL still running after the API exited: %v", err)
	}
}
