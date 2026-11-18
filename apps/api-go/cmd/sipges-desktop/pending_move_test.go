package main

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/localpg/pgbin"
)

// A cluster that --prepare-only made and the PGlite move has not filled yet (the pending-move
// mark beside it) is never started by the managed launcher: it would migrate an empty database
// and the move would then refuse it.
func TestAPreparedClusterWaitingForTheMoveIsNeverStarted(t *testing.T) {
	f := newFixture(t)
	put(t, filepath.Join(f.state, "pglite", "PG_VERSION"), "18\n")
	put(t, filepath.Join(f.state, "pg18", "PG_VERSION"), "18\n")
	put(t, filepath.Join(f.state, pendingMoveName), "")
	var stdout, stderr bytes.Buffer
	code := runLauncherCLI(context.Background(), []string{"--install", f.root, "--port", "18004"}, nil, &stdout, &stderr, nil)
	if code != 1 {
		t.Fatalf("exit %d\n%s", code, stderr.String())
	}
	events := parseEvents(t, stdout.String())
	if len(events) != 1 || events[0]["event"] != "start_refused" ||
		events[0]["reason"] != "The PostgreSQL 18 cluster is waiting for the PGlite move (pg18.pending-move)" ||
		events[0]["action"] != pendingMoveNotice || !strings.Contains(stderr.String(), pendingMoveNotice) {
		t.Fatalf("events %v\n%s", events, stderr.String())
	}
	if _, err := os.Stat(filepath.Join(f.root, "first-start.json")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("first-start.json was written: %v", err)
	}
}

// The plain mode refuses it too, before PostgreSQL starts.
func TestThePlainModeRefusesAClusterWaitingForTheMove(t *testing.T) {
	state := t.TempDir()
	put(t, filepath.Join(state, "pg18", "PG_VERSION"), "18\n")
	put(t, filepath.Join(state, pendingMoveName), "")
	err := run(context.Background(), []string{"--state", state, "--pg-bin", t.TempDir()}, nil, io.Discard, io.Discard)
	if err == nil || userMessage(err) != pendingMoveNotice {
		t.Fatalf("%v / %q", err, userMessage(err))
	}
	if _, statErr := os.Stat(filepath.Join(state, "pg18", "postmaster.pid")); !errors.Is(statErr, os.ErrNotExist) {
		t.Fatal("PostgreSQL was started")
	}
}

// --prepare-only leaves the mark; a failed one removes it with the half-made cluster.
func TestPrepareOnlyMarksTheClusterAsWaitingForTheMove(t *testing.T) {
	bin := pgbin.ForTest(t)
	state := t.TempDir()
	put(t, filepath.Join(state, "data-key"), "c3ludGhldGljLWRhdGEta2V5LTMyLWJ5dGVzLXh4eHg=\n")
	put(t, filepath.Join(state, "admin-password"), "SyntheticAdmin-2026\n")
	if err := run(context.Background(), []string{"--state", state, "--pg-bin", bin, "--prepare-only"}, []string{"PATH=" + os.Getenv("PATH")}, io.Discard, io.Discard); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(state, pendingMoveName)); err != nil {
		t.Fatalf("no pending-move mark: %v", err)
	}

	failed := t.TempDir()
	put(t, filepath.Join(failed, "data-key"), "c3ludGhldGljLWRhdGEta2V5LTMyLWJ5dGVzLXh4eHg=\n")
	put(t, filepath.Join(failed, "admin-password"), "SyntheticAdmin-2026\n")
	saved := prepareCheck
	prepareCheck = func(context.Context, string) error { return errors.New("synthetic failure") }
	t.Cleanup(func() { prepareCheck = saved })
	if err := run(context.Background(), []string{"--state", failed, "--pg-bin", bin, "--prepare-only"}, []string{"PATH=" + os.Getenv("PATH")}, io.Discard, io.Discard); err == nil {
		t.Fatal("the failing --prepare-only succeeded")
	}
	for _, name := range []string{"pg18", pendingMoveName} {
		if _, err := os.Stat(filepath.Join(failed, name)); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("%s is still there: %v", name, err)
		}
	}
}
