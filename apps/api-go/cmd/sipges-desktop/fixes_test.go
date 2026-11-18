package main

import (
	"context"
	"errors"
	"io"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/localpg/pgbin"
)

// helperEnv makes this test binary act as an API that stops cleanly on SIGTERM (TestMain).
const helperEnv = "SIPGES_DESKTOP_TEST_API"

func TestMain(m *testing.M) {
	if dir := os.Getenv(helperEnv); dir != "" {
		fakeAPI(dir)
		return
	}
	os.Exit(m.Run())
}

// fakeAPI reports it is ready, then writes "terminated" when asked to stop. A kill never lets it.
func fakeAPI(dir string) {
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	_ = os.WriteFile(filepath.Join(dir, "ready"), nil, 0o600)
	select {
	case <-stop:
		_ = os.WriteFile(filepath.Join(dir, "terminated"), nil, 0o600)
	case <-time.After(time.Minute):
	}
	os.Exit(0)
}

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

func TestAShutdownDuringStartupIsNotAFailure(t *testing.T) {
	bin := pgbin.ForTest(t)
	state := t.TempDir()
	writeLauncherSecrets(t, state)
	ctx, cancel := context.WithCancel(context.Background())
	cancel() // SIGINT arrived before the API was up
	args := []string{"--state", state, "--pg-bin", bin, "--api", "/nonexistent", "--migrations", t.TempDir()}
	if err := run(ctx, args, nil, io.Discard, io.Discard); err != nil {
		t.Fatalf("run = %v (%q), want nil for a requested stop", err, userMessage(err))
	}
	if _, err := os.Stat(filepath.Join(state, "pg18", "postmaster.pid")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("PostgreSQL left running: %v", err)
	}
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
