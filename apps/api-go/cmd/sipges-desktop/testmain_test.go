package main

import (
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

// helperEnv makes this test binary act as an API that stops cleanly on SIGTERM (TestMain).
const helperEnv = "SIPGES_DESKTOP_TEST_API"

// launcherEnvHelper makes this test binary run the managed launcher with these arguments
// (separated by \x1f), so a test can kill it as the person's computer would.
const launcherEnvHelper = "SIPGES_DESKTOP_TEST_LAUNCHER"

func TestMain(m *testing.M) {
	if args := os.Getenv(launcherEnvHelper); args != "" {
		os.Exit(launcherMain(strings.Split(args, "\x1f")))
	}
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
