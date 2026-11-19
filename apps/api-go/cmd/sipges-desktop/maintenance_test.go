package main

// The recovery and maintenance commands of update.mjs (--recover, --accept-restored-state,
// --copies, --remove-copies-older-than), ported from updater.test.mjs and copies.test.mjs.

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/desktopupdate"
)

// maintenanceCLI runs the command line as an operator does, with no PostgreSQL left running.
func maintenanceCLI(t *testing.T, args ...string) (code int, stdout, stderr string) {
	t.Helper()
	return installCLI(t, args...)
}

func runMaintenanceWith(t *testing.T, root string, stop func(context.Context, []string) error, args ...string) (code int, stdout, stderr string) {
	t.Helper()
	o, err := parseLauncherArgs(append([]string{"--install", root}, args...), lookupOf(nil))
	if err != nil {
		t.Fatal(err)
	}
	var out, errOut bytes.Buffer
	code = runMaintenance(context.Background(), root, o, &out, &errOut, stop)
	return code, out.String(), errOut.String()
}

func siblingNames(t *testing.T, state string) []string {
	t.Helper()
	entries, err := os.ReadDir(filepath.Dir(state))
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), filepath.Base(state)+".") {
			names = append(names, e.Name())
		}
	}
	return names
}

// stateCopy makes a copy beside the state folder named as the updater names them.
func stateCopy(t *testing.T, state, kind string, at time.Time, suffix string) string {
	t.Helper()
	path := state + "." + kind + "-" + at.UTC().Format("20060102T150405Z") + "-" + suffix
	put(t, filepath.Join(path, "data"), strings.Repeat("x", 100))
	return path
}

func TestRecoverWithNothingPendingSaysSo(t *testing.T) {
	f := newFixture(t)
	code, stdout, stderr := maintenanceCLI(t, "--install", f.root, "--recover")
	if code != 0 || stdout != "Nothing to recover; current version 1.0.0.\n" || stderr != "" {
		t.Fatalf("exit %d stdout %q stderr %q", code, stdout, stderr)
	}
}

func TestRecoverRollsBackAnInterruptedUpdate(t *testing.T) {
	f := newFixture(t)
	pendingJournal(t, f)
	code, stdout, stderr := maintenanceCLI(t, "--install", f.root, "--recover")
	if code != 0 || stdout != "Recovered: rolled back to 1.0.0.\n" || stderr != "" {
		t.Fatalf("exit %d stdout %q stderr %q", code, stdout, stderr)
	}
	if _, err := os.Stat(filepath.Join(f.root, "update-journal.json")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("journal left: %v", err)
	}
}

func TestTheMaintenanceOptionsAreCheckedAsUpdateMjsChecksThem(t *testing.T) {
	f := newFixture(t)
	cases := []struct {
		args []string
		want string
	}{
		{[]string{"--accept-restored-state"}, "Error: --accept-restored-state goes with --recover\n"},
		{[]string{"--copies", "--accept-restored-state"}, "Error: --accept-restored-state goes with --recover\n"},
		{[]string{"--recover", "--port", "8001"}, "Error: --recover takes only --install and --accept-restored-state\n"},
		{[]string{"--recover", "--releases", "x"}, "Error: --recover takes only --install and --accept-restored-state\n"},
		{[]string{"--recover", "--prepare-only"}, "Error: --recover takes only --install and --accept-restored-state\n"},
		{[]string{"--recover", "--release", "x", "--state", "y"}, "Error: --recover takes only --install and --accept-restored-state\n"},
		{[]string{"--copies", "--recover"}, "Error: --copies and --remove-copies-older-than take only --install\n"},
		{[]string{"--copies", "--remove-copies-older-than", "30"}, "Error: --copies and --remove-copies-older-than take only --install\n"},
		{[]string{"--remove-copies-older-than", "30", "--port", "8001"}, "Error: --copies and --remove-copies-older-than take only --install\n"},
		{[]string{"--recover", "--recover"}, "Error: Invalid options; use --help\n"},
		{[]string{"--recover=1"}, "Error: Invalid options; use --help\n"},
		{[]string{"--remove-copies-older-than"}, "Error: Invalid options; use --help\n"},
	}
	for _, c := range cases {
		code, stdout, stderr := maintenanceCLI(t, append([]string{"--install", f.root}, c.args...)...)
		if code != 1 || stdout != "" || stderr != c.want {
			t.Errorf("%v: exit %d stdout %q stderr %q", c.args, code, stdout, stderr)
		}
	}
}

// updater.test.mjs: the way out of a halt, after restoring one's own backup.
func TestAcceptRestoredStateIsTheWayOutOfAHalt(t *testing.T) {
	f := newFixture(t)
	put(t, filepath.Join(f.state, "pg18", "PG_VERSION"), "18\n")
	backup := filepath.Join(f.dir, "own-backup")
	put(t, filepath.Join(backup, "pg18", "PG_VERSION"), "18\n")
	release := f.release("1.1.0", releaseOptions{})
	_, err := desktopupdate.Update(context.Background(), desktopupdate.UpdateOptions{
		Root: f.root, Release: release, Verifier: releaseVerifier{},
		Migrate: func(_ context.Context, target desktopupdate.Target) error {
			put(t, filepath.Join(target.StateDir, "pg18", "PG_VERSION"), "half migrated\n")
			removePreUpdateCopies(target.StateDir)
			return errors.New("synthetic migration failure")
		},
		Ready: func(context.Context, desktopupdate.Target) error { return nil },
	})
	if desktopupdate.ExitCode(err) != 3 {
		t.Fatalf("update: %v", err)
	}
	journal := filepath.Join(f.root, "update-journal.json")
	pending, err := os.ReadFile(journal)
	if err != nil {
		t.Fatal(err)
	}
	accept := func() (int, string, string) {
		return maintenanceCLI(t, "--install", f.root, "--recover", "--accept-restored-state")
	}
	if code, stdout, stderr := maintenanceCLI(t, "--install", f.root, "--recover"); code != 3 || stdout != "" || !strings.HasPrefix(stderr, "Error: ") {
		t.Fatalf("still halted: exit %d stdout %q stderr %q", code, stdout, stderr)
	}

	if err := os.Rename(f.state, filepath.Join(f.dir, "half-migrated-aside")); err != nil {
		t.Fatal(err)
	}
	code, stdout, stderr := accept()
	if code != 1 || stdout != "" || !regexp.MustCompile(`^Error: The state folder .+ does not exist: restore your backup there first\n$`).MatchString(stderr) {
		t.Fatalf("missing: exit %d stdout %q stderr %q", code, stdout, stderr)
	}
	mkdir(t, f.state)
	code, stdout, stderr = accept()
	if code != 1 || stdout != "" || !regexp.MustCompile(`^Error: The state folder .+ is empty: restore your backup there first\n$`).MatchString(stderr) {
		t.Fatalf("empty: exit %d stdout %q stderr %q", code, stdout, stderr)
	}
	if again, _ := os.ReadFile(journal); !bytes.Equal(again, pending) {
		t.Fatal("the journal changed while refused")
	}

	if err := os.Remove(f.state); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(backup, f.state); err != nil {
		t.Fatal(err)
	}
	besides := siblingNames(t, f.state)
	code, stdout, stderr = accept()
	if code != 0 || stdout != "Accepted the restored state folder; current version 1.0.0.\n" || stderr != "" {
		t.Fatalf("accept: exit %d stdout %q stderr %q", code, stdout, stderr)
	}
	if got, _ := os.ReadFile(filepath.Join(f.state, "pg18", "PG_VERSION")); string(got) != "18\n" {
		t.Fatalf("the restored state changed: %q", got)
	}
	if got := siblingNames(t, f.state); !slices.Equal(got, besides) {
		t.Fatalf("copies beside changed: %v, was %v", got, besides)
	}
	if _, err := os.Stat(journal); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("journal left: %v", err)
	}
	for _, args := range [][]string{{"--recover", "--accept-restored-state"}, {"--recover"}} {
		code, stdout, _ := maintenanceCLI(t, append([]string{"--install", f.root}, args...)...)
		if code != 0 || stdout != "Nothing to recover; current version 1.0.0.\n" {
			t.Fatalf("%v: exit %d stdout %q", args, code, stdout)
		}
	}
}

// copies.test.mjs: lists the copies and removes old ones, saying which copy it refused to remove.
func TestCopiesAreListedAndOldOnesRemoved(t *testing.T) {
	f := newFixture(t)
	mkdir(t, f.state)
	daysAgo := func(n int) time.Time { return time.Now().Add(-time.Duration(n) * 24 * time.Hour) }
	only := stateCopy(t, f.state, "pre-update", daysAgo(60), "first-start-1.0.0")
	rehearsal := stateCopy(t, f.state, "rehearsal", daysAgo(60), "1.0.0")

	code, stdout, stderr := maintenanceCLI(t, "--install", f.root, "--copies")
	if code != 0 || stderr != "" {
		t.Fatalf("exit %d stderr %q", code, stderr)
	}
	if !regexp.MustCompile(`^Copies beside `+regexp.QuoteMeta(f.state)+`: 2, \d+ bytes\n`).MatchString(stdout) ||
		!regexp.MustCompile(`(?m)^ {2}pre-update \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ \d+ bytes `+regexp.QuoteMeta(only)+`$`).MatchString(stdout) {
		t.Fatalf("stdout %q", stdout)
	}

	code, stdout, stderr = maintenanceCLI(t, "--install", f.root, "--remove-copies-older-than", "30")
	if code != 0 || stderr != "" {
		t.Fatalf("exit %d stderr %q", code, stderr)
	}
	for _, want := range []string{
		`(?m)^Removed ` + regexp.QuoteMeta(rehearsal) + ` \(\d+ bytes\)$`,
		`(?m)^Kept ` + regexp.QuoteMeta(only) + `: the newest pre-update copy is never removed\.$`,
		`(?m)^Removed 1 copy \(\d+ bytes\); 1 left beside the state folder\.$`,
	} {
		if !regexp.MustCompile(want).MatchString(stdout) {
			t.Fatalf("stdout %q lacks %s", stdout, want)
		}
	}
	if got := siblingNames(t, f.state); !slices.Equal(got, []string{filepath.Base(only)}) {
		t.Fatalf("left %v", got)
	}

	code, stdout, _ = maintenanceCLI(t, "--install", f.root, "--remove-copies-older-than=30")
	if code != 0 || !strings.Contains(stdout, "the newest pre-update copy is never removed.\n") || !strings.HasSuffix(stdout, "Nothing removed.\n") {
		t.Fatalf("again: exit %d stdout %q", code, stdout)
	}
	if got := siblingNames(t, f.state); !slices.Equal(got, []string{filepath.Base(only)}) {
		t.Fatalf("left %v", got)
	}
}

// copies.test.mjs: refused while an update is pending or halted, and for a bad age.
func TestRemovingCopiesIsRefusedForABadAgeOrAPendingUpdate(t *testing.T) {
	f := newFixture(t)
	mkdir(t, f.state)
	old := time.Now().Add(-60 * 24 * time.Hour)
	stateCopy(t, f.state, "pre-update", old, "first-start-1.0.0")
	stateCopy(t, f.state, "rehearsal", old, "1.0.0")
	before := siblingNames(t, f.state)
	for _, days := range []string{"0", "-3", "treinta", "1.5"} {
		code, stdout, stderr := maintenanceCLI(t, "--install", f.root, "--remove-copies-older-than", days)
		if code != 1 || stdout != "" || stderr != "Error: --remove-copies-older-than takes a whole number of days, 1 or more\n" {
			t.Errorf("%s: exit %d stdout %q stderr %q", days, code, stdout, stderr)
		}
	}
	put(t, filepath.Join(f.root, "update-journal.json"), `{"phase":"migrating"}`+"\n")
	code, _, stderr := maintenanceCLI(t, "--install", f.root, "--remove-copies-older-than", "30")
	if code != 1 || !strings.HasPrefix(stderr, "Error: An update is pending or halted") {
		t.Fatalf("exit %d stderr %q", code, stderr)
	}
	if got := siblingNames(t, f.state); !slices.Equal(got, before) {
		t.Fatalf("copies changed: %v", got)
	}
}

// A huge age removes nothing, as in update.mjs, instead of wrapping around to a future limit.
func TestAHugeAgeRemovesNothing(t *testing.T) {
	f := newFixture(t)
	mkdir(t, f.state)
	stateCopy(t, f.state, "rehearsal", time.Now().Add(-60*24*time.Hour), "1.0.0")
	code, stdout, stderr := maintenanceCLI(t, "--install", f.root, "--remove-copies-older-than", "99999999999999999999")
	if code != 0 || stdout != "Nothing removed.\n" || stderr != "" {
		t.Fatalf("exit %d stdout %q stderr %q", code, stdout, stderr)
	}
}

// Never recover or remove copies while a launcher runs this install: nothing changes.
func TestRecoveryAndRemovalAreRefusedWhileALauncherRuns(t *testing.T) {
	f := newFixture(t)
	pendingJournal(t, f)
	lock, err := acquireLauncherLock(f.root)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = lock.Close() }()
	journal, _ := os.ReadFile(filepath.Join(f.root, "update-journal.json"))
	before := siblingNames(t, f.state)
	for _, args := range [][]string{{"--recover"}, {"--recover", "--accept-restored-state"}, {"--remove-copies-older-than", "1"}} {
		code, stdout, stderr := maintenanceCLI(t, append([]string{"--install", f.root}, args...)...)
		if code != 1 || stdout != "" || !strings.HasPrefix(stderr, "SIPGES está en ejecución en este equipo: ciérrelo antes de recuperar o borrar copias.\nError: ") {
			t.Errorf("%v: exit %d stdout %q stderr %q", args, code, stdout, stderr)
		}
	}
	if again, _ := os.ReadFile(filepath.Join(f.root, "update-journal.json")); !bytes.Equal(again, journal) {
		t.Fatal("the journal changed")
	}
	if got := siblingNames(t, f.state); !slices.Equal(got, before) {
		t.Fatalf("copies changed: %v", got)
	}
	// Listing reads only: it works while SIPGES runs.
	if code, stdout, _ := maintenanceCLI(t, "--install", f.root, "--copies"); code != 0 || !strings.HasPrefix(stdout, "Copies beside ") {
		t.Fatalf("--copies: exit %d %q", code, stdout)
	}
}

// As the managed start: a PostgreSQL a killed launcher left running is stopped before recovery.
func TestLeftoverServersAreStoppedBeforeRecoveryAndRemoval(t *testing.T) {
	for _, args := range [][]string{{"--recover"}, {"--remove-copies-older-than", "1"}} {
		f := newFixture(t)
		pre := pendingJournal(t, f)
		if args[0] != "--recover" {
			_ = os.Remove(filepath.Join(f.root, "update-journal.json"))
		}
		calls := &orphanCalls{}
		code, _, stderr := runMaintenanceWith(t, f.root, calls.stopper(f.root, nil), args...)
		if code != 0 {
			t.Fatalf("%v: exit %d %q", args, code, stderr)
		}
		if len(calls.calls) != 1 || !slices.Contains(calls.calls[0], f.state) || !slices.Contains(calls.calls[0], pre) {
			t.Fatalf("%v: folders %v", args, calls.calls)
		}
		if args[0] == "--recover" && !calls.journalAtCall[0] {
			t.Fatal("stopped after recovery")
		}
	}
}

// A leftover PostgreSQL that cannot be stopped refuses with a Spanish notice; nothing changes.
func TestALeftoverServerThatCannotBeStoppedChangesNothing(t *testing.T) {
	f := newFixture(t)
	pendingJournal(t, f)
	journal, _ := os.ReadFile(filepath.Join(f.root, "update-journal.json"))
	before := siblingNames(t, f.state)
	calls := &orphanCalls{}
	code, stdout, stderr := runMaintenanceWith(t, f.root, calls.stopper(f.root, errors.New("pg_ctl stop: synthetic failure")), "--recover")
	if code != 1 || stdout != "" ||
		!strings.HasPrefix(stderr, maintenanceOrphanNotice+"\nError: ") || !strings.Contains(stderr, "synthetic failure") {
		t.Fatalf("exit %d stdout %q stderr %q", code, stdout, stderr)
	}
	if again, _ := os.ReadFile(filepath.Join(f.root, "update-journal.json")); !bytes.Equal(again, journal) {
		t.Fatal("the journal changed")
	}
	if got := siblingNames(t, f.state); !slices.Equal(got, before) {
		t.Fatalf("copies changed: %v", got)
	}
	// Listing never stops a server.
	if code, _, _ := runMaintenanceWith(t, f.root, func(context.Context, []string) error {
		t.Fatal("--copies stopped a server")
		return nil
	}, "--copies"); code != 0 {
		t.Fatalf("--copies exit %d", code)
	}
}

func TestTheHelpListsTheMaintenanceCommands(t *testing.T) {
	code, stdout, _ := maintenanceCLI(t, "--help")
	for _, want := range []string{
		"sipges-desktop --install <root> --recover [--accept-restored-state]",
		"sipges-desktop --install <root> --copies",
		"sipges-desktop --install <root> --remove-copies-older-than <days>",
	} {
		if code != 0 || !strings.Contains(stdout, want) {
			t.Fatalf("help lacks %q:\n%s", want, stdout)
		}
	}
}
