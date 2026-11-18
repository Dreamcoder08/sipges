package main

import (
	"context"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/localpg"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/localpg/pgbin"
)

func writeLauncherSecrets(t *testing.T, state string) {
	t.Helper()
	writeFile(t, filepath.Join(state, "data-key"), "c3ludGhldGljLWRhdGEta2V5LTMyLWJ5dGVzLXh4eHg=\n")
	writeFile(t, filepath.Join(state, "admin-password"), "SyntheticAdmin-2026\n")
}

func TestALostSuperuserPasswordIsNeverRegeneratedForAnExistingCluster(t *testing.T) {
	state := t.TempDir()
	writeLauncherSecrets(t, state)
	if err := os.MkdirAll(filepath.Join(state, "pg18"), 0o700); err != nil {
		t.Fatal(err)
	}
	writeFile(t, filepath.Join(state, "pg18", "PG_VERSION"), "18\n")
	_, err := readSecrets(state)
	if err == nil {
		t.Fatal("readSecrets created a new superuser password for an existing cluster")
	}
	msg := userMessage(err)
	for _, want := range []string{superPasswordFile, "copia de seguridad"} {
		if !strings.Contains(msg, want) {
			t.Errorf("message %q does not mention %q", msg, want)
		}
	}
	if _, err := os.Stat(filepath.Join(state, superPasswordFile)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("a new %s was written: %v", superPasswordFile, err)
	}
}

func TestMigrationsAreAskedToStopNotKilled(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("the helper API stops on SIGTERM")
	}
	dir := t.TempDir()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		done <- migrateAPI(ctx, os.Args[0], append(os.Environ(), helperEnv+"="+dir), io.Discard, io.Discard)
	}()
	waitFile(t, filepath.Join(dir, "ready"))
	cancel()
	select {
	case err := <-done:
		t.Logf("migrateAPI after the stop request: %v", err)
	case <-time.After(30 * time.Second):
		t.Fatal("migrateAPI did not return after its context ended")
	}
	if _, err := os.Stat(filepath.Join(dir, "terminated")); err != nil {
		t.Fatalf("the migration was killed instead of asked to stop: %v", err)
	}
}

func TestAShutdownAfterPostgresStartedStopsItAndIsNotAFailure(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("the helper API stops on SIGTERM")
	}
	bin := pgbin.ForTest(t)
	state, api := t.TempDir(), t.TempDir()
	writeLauncherSecrets(t, state)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() {
		done <- run(ctx, desktopArgs(t, state, bin), []string{helperEnv + "=" + api}, io.Discard, io.Discard)
	}()
	waitFile(t, filepath.Join(api, "ready")) // PostgreSQL is up and `api migrate` is running
	pid := postmasterPID(t, state)
	cancel() // Ctrl+C
	if err := wait(t, done); err != nil {
		t.Fatalf("run = %v (%q), want nil for a requested stop", err, userMessage(err))
	}
	if _, err := os.Stat(filepath.Join(state, "pg18", "postmaster.pid")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("PostgreSQL left running: %v", err)
	}
	if p, err := os.FindProcess(pid); err == nil && p.Signal(syscall.Signal(0)) == nil {
		t.Fatalf("postmaster %d still alive after the shutdown", pid)
	}
}

func TestAFailedPostgresStopDuringShutdownIsAFailure(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("the helper API stops on SIGTERM")
	}
	realBin := pgbin.ForTest(t)
	failStop := filepath.Join(t.TempDir(), "fail-stop")
	bin := pgbin.FailingStop(t, realBin, failStop)
	state, api := t.TempDir(), t.TempDir()
	writeLauncherSecrets(t, state)
	t.Cleanup(func() {
		stop := exec.Command(filepath.Join(realBin, "pg_ctl"), "stop", "-D", filepath.Join(state, "pg18"), "-m", "immediate")
		_ = stop.Run()
	})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() {
		done <- run(ctx, desktopArgs(t, state, bin), []string{helperEnv + "=" + api}, io.Discard, io.Discard)
	}()
	waitFile(t, filepath.Join(api, "ready"))
	writeFile(t, failStop, "")
	cancel() // Ctrl+C, and then PostgreSQL does not stop
	err := wait(t, done)
	if !errors.Is(err, localpg.ErrStop) {
		t.Fatalf("run = %v, want the ErrStop of the failed stop", err)
	}
	if msg := userMessage(err); !strings.Contains(msg, "no se detuvo") {
		t.Fatalf("user message %q does not say the database did not stop", msg)
	}
}

// desktopArgs runs this test binary as the API (helperEnv), on a free port.
func desktopArgs(t *testing.T, state, bin string) []string {
	t.Helper()
	return []string{"--state", state, "--pg-bin", bin, "--api", os.Args[0], "--migrations", t.TempDir(), "--port", strconv.Itoa(freePort(t))}
}

func wait(t *testing.T, done chan error) error {
	t.Helper()
	select {
	case err := <-done:
		return err
	case <-time.After(2 * time.Minute):
		t.Fatal("run did not return after the stop request")
		return nil
	}
}

func postmasterPID(t *testing.T, state string) int {
	t.Helper()
	body, err := os.ReadFile(filepath.Join(state, "pg18", "postmaster.pid"))
	if err != nil {
		t.Fatal(err)
	}
	line, _, _ := strings.Cut(string(body), "\n")
	pid, err := strconv.Atoi(strings.TrimSpace(line))
	if err != nil {
		t.Fatal(err)
	}
	return pid
}

func waitFile(t *testing.T, path string) {
	t.Helper()
	for range 200 {
		if _, err := os.Stat(path); err == nil {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("%s never appeared", path)
}
