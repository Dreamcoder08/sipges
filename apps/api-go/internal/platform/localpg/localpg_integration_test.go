package localpg

import (
	"context"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/localpg/pgbin"
)

const testPassword = "synthetic-superuser-password"

// options returns a fresh cluster layout in scratch folders, or skips without PostgreSQL 18
// binaries (SIPGES_PG_BIN, or pg_ctl on PATH).
func options(t *testing.T) Options {
	t.Helper()
	bin := pgbin.ForTest(t)
	root := t.TempDir()
	return Options{
		BinDir:        bin,
		DataDir:       filepath.Join(root, "pg18"),
		LogPath:       filepath.Join(root, "pg18.log"),
		SuperPassword: testPassword,
	}
}

func startT(t *testing.T, opts Options) *Server {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	s, err := Start(ctx, opts)
	if err != nil {
		log, _ := os.ReadFile(opts.LogPath)
		t.Fatalf("Start: %v\nlog:\n%s", err, log)
	}
	t.Cleanup(func() { _ = s.Stop(context.Background()) })
	return s
}

func TestStartInitialisesWithThePinnedLocaleOnAFreeLoopbackPort(t *testing.T) {
	opts := options(t)
	s := startT(t, opts)
	if s.Port() <= 0 || s.Port() == 5432 {
		t.Fatalf("port %d: want a free port chosen at start, never 5432 by assumption", s.Port())
	}
	ctx := context.Background()
	if err := s.Ping(ctx); err != nil {
		t.Fatalf("Ping: %v", err)
	}
	conn, err := pgx.Connect(ctx, s.URL(DefaultSuperUser, testPassword, "postgres"))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = conn.Close(ctx) }()
	for setting, want := range map[string]string{
		"SHOW listen_addresses":        "127.0.0.1",
		"SHOW server_encoding":         "UTF8",
		"SHOW unix_socket_directories": "",
		"SELECT current_setting('server_version_num')::int / 10000 || ''":                              "18",
		"SELECT datlocprovider::text || ':' || datlocale FROM pg_database WHERE datname = 'template1'": "b:C.UTF-8",
	} {
		var got string
		if err := conn.QueryRow(ctx, setting).Scan(&got); err != nil {
			t.Fatalf("%s: %v", setting, err)
		}
		if got != want {
			t.Errorf("%s = %q, want %q", setting, got, want)
		}
	}
	if _, err := os.Stat(filepath.Join(opts.DataDir, "PG_VERSION")); err != nil {
		t.Fatalf("PG_VERSION: %v", err)
	}
}

func TestStartRefusesAWrongSuperuserPassword(t *testing.T) {
	s := startT(t, options(t))
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, s.URL(DefaultSuperUser, "not-the-password", "postgres"))
	if err == nil {
		_ = conn.Close(ctx)
		t.Fatal("a wrong password connected: the cluster must require scram-sha-256")
	}
}

func TestStopLeavesNoServerProcess(t *testing.T) {
	opts := options(t)
	s := startT(t, opts)
	pid := postmasterPID(t, opts.DataDir)
	if err := s.Stop(context.Background()); err != nil {
		t.Fatalf("Stop: %v", err)
	}
	if _, err := os.Stat(filepath.Join(opts.DataDir, "postmaster.pid")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("postmaster.pid still there after Stop: %v", err)
	}
	if alive(pid) {
		t.Fatalf("postmaster %d still alive after Stop", pid)
	}
	conn, err := net.DialTimeout("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(s.Port())), time.Second)
	if err == nil {
		_ = conn.Close()
		t.Fatalf("port %d still accepts connections after Stop", s.Port())
	}
	if err := s.Stop(context.Background()); err != nil {
		t.Fatalf("a second Stop must be a no-op: %v", err)
	}
}

func TestASecondStartReusesTheData(t *testing.T) {
	opts := options(t)
	ctx := context.Background()
	first := startT(t, opts)
	execSQL(t, first, "CREATE TABLE synthetic_probe (note text)", "INSERT INTO synthetic_probe VALUES ('kept')")
	version, err := os.Stat(filepath.Join(opts.DataDir, "PG_VERSION"))
	if err != nil {
		t.Fatal(err)
	}
	if err := first.Stop(ctx); err != nil {
		t.Fatal(err)
	}

	second := startT(t, opts)
	var note string
	conn, err := pgx.Connect(ctx, second.URL(DefaultSuperUser, testPassword, "postgres"))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = conn.Close(ctx) }()
	if err := conn.QueryRow(ctx, "SELECT note FROM synthetic_probe").Scan(&note); err != nil || note != "kept" {
		t.Fatalf("data after restart: %q, %v", note, err)
	}
	again, err := os.Stat(filepath.Join(opts.DataDir, "PG_VERSION"))
	if err != nil || !again.ModTime().Equal(version.ModTime()) {
		t.Fatalf("PG_VERSION rewritten: initdb must run only once (%v)", err)
	}
}

func TestStartStopsAServerLeftRunningOnTheSameFolder(t *testing.T) {
	opts := options(t)
	first := startT(t, opts)
	// The launcher died without stopping it: a new Start must not fail on the busy folder.
	second := startT(t, opts)
	if err := second.Ping(context.Background()); err != nil {
		t.Fatalf("Ping after restart: %v", err)
	}
	_ = first
}

func execSQL(t *testing.T, s *Server, statements ...string) {
	t.Helper()
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, s.URL(DefaultSuperUser, testPassword, "postgres"))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = conn.Close(ctx) }()
	for _, statement := range statements {
		if _, err := conn.Exec(ctx, statement); err != nil {
			t.Fatalf("%s: %v", statement, err)
		}
	}
}

func postmasterPID(t *testing.T, dataDir string) int {
	t.Helper()
	body, err := os.ReadFile(filepath.Join(dataDir, "postmaster.pid"))
	if err != nil {
		t.Fatal(err)
	}
	pid, err := strconv.Atoi(strings.TrimSpace(strings.SplitN(string(body), "\n", 2)[0]))
	if err != nil {
		t.Fatal(fmt.Errorf("postmaster.pid: %w", err))
	}
	return pid
}

// alive reports whether a process with this id still runs (Unix: signal 0 succeeds).
func alive(pid int) bool {
	_, err := os.Stat(filepath.Join("/proc", strconv.Itoa(pid)))
	return err == nil
}
