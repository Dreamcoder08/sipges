package desktopupdate

// Port of deploy/desktop/updater/restore-recreated-state.test.mjs and the halt cases of
// updater.test.mjs: a restore halted halfway must never be reported recovered on a state folder
// created again since.

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type halted struct {
	root, state, pre, failed, restoring, journal, journalText string
	before                                                    map[string]string
}

// haltedRestore is an installed 1.0.0 whose update to 1.1.0 halted in the restore: the migrated
// state moved aside as .failed-…, its fresh copy still .restoring-… and nothing at the state name.
func haltedRestore(t *testing.T, dir string) halted {
	t.Helper()
	state := filepath.Join(dir, "SIPGES-datos")
	f := newFixtureAt(t, dir, state, true)
	h := halted{
		root: f.root, state: state, before: snapshot(t, state),
		pre:       state + ".pre-update-20261114T100000Z-1.0.0-to-1.1.0",
		failed:    state + ".failed-20261114T100000Z-1.1.0",
		restoring: state + ".restoring-20261114T100000Z-x",
		journal:   filepath.Join(f.root, "update-journal.json"),
	}
	for _, target := range []string{h.pre, h.restoring} {
		if err := copyDir(state, target); err != nil {
			t.Fatal(err)
		}
	}
	put(t, filepath.Join(state, "pglite/PG_VERSION"), "half migrated by 1.1.0\n", 0)
	if err := os.Rename(state, h.failed); err != nil {
		t.Fatal(err)
	}
	journal := map[string]any{
		"from":     map[string]any{"version": "1.0.0", "path": "versions/1.0.0", "adopted": false},
		"to":       map[string]any{"version": "1.1.0", "path": "versions/1.1.0"},
		"stateDir": state, "preCopy": h.pre, "failedAside": h.failed, "restoring": h.restoring, "phase": "restoring",
	}
	data, err := json.MarshalIndent(journal, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	h.journalText = string(data) + "\n"
	put(t, h.journal, h.journalText, 0)
	return h
}

// folders snapshots every folder beside the state folder and the state folder itself, by name.
func folders(t *testing.T, state string) map[string]map[string]string {
	t.Helper()
	out := map[string]map[string]string{}
	for _, name := range append(siblings(t, state), filepath.Base(state)) {
		path := filepath.Join(filepath.Dir(state), name)
		if exists(t, path) {
			out[name] = snapshot(t, path)
		}
	}
	return out
}

func assertFolders(t *testing.T, got, want map[string]map[string]string, label string) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("%s: %d folders, want %d", label, len(got), len(want))
	}
	for name, tree := range want {
		assertSnapshot(t, got[name], tree, label+": "+name)
	}
}

func recoverErr(t *testing.T, root string) *Error {
	t.Helper()
	_, err := Recover(context.Background(), root)
	return wantCode(t, err, CodeRollbackIncomplete, "recover")
}

func TestRecreatedUnrestoredStateIsNeverReportedRecovered(t *testing.T) {
	h := haltedRestore(t, t.TempDir())
	if err := os.MkdirAll(filepath.Join(h.state, "pglite"), 0o755); err != nil {
		t.Fatal(err)
	}
	_, err := Recover(context.Background(), h.root)
	restored := sameMap(snapshot(t, h.state), h.before)
	if !restored && codeOf(err) != CodeRollbackIncomplete {
		t.Fatal("recovered without restoring")
	}
	if !restored && !exists(t, h.journal) {
		t.Fatal("journal removed")
	}
}

func TestStateCreatedAgainWhileItsRestoreWaitsIsRefusedJournalAndFoldersKept(t *testing.T) {
	dir := t.TempDir()
	h := haltedRestore(t, dir)
	for _, sub := range []string{"pglite", "uploads"} {
		if err := os.MkdirAll(filepath.Join(h.state, sub), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	untouched := folders(t, h.state)
	if n := len(siblings(t, h.state)); n != 3 {
		t.Fatalf("siblings %d", n)
	}
	e := recoverErr(t, h.root)
	if e.PreUpdateCopy != h.pre {
		t.Fatalf("pre-update copy %q", e.PreUpdateCopy)
	}
	want := "An interrupted update to 1.1.0 could not be rolled back (the state folder " + h.state +
		" was created again while its restore was pending; the restored data is still in " + h.restoring +
		": move " + h.state + " aside without deleting anything, then run --recover again). Do not start SIPGES on this state folder: run --recover to retry, or restore it from the pre-update copy: " + h.pre
	if e.Message != want {
		t.Fatalf("message\n got %q\nwant %q", e.Message, want)
	}
	if readText(t, h.journal) != h.journalText {
		t.Fatal("journal changed")
	}
	assertFolders(t, folders(t, h.state), untouched, "no folder changed")
	assertSnapshot(t, untouched[filepath.Base(h.restoring)], h.before, "restoring copy")
	if c, _ := ReadCurrent(h.root); c.Version != "1.0.0" {
		t.Fatal("current")
	}
	if last := lastLog(t, h.root); last["event"] != "rollback-incomplete" || last["phase"] != "restoring" {
		t.Fatalf("log %v", last)
	}
	if ExitCode(e) != 3 {
		t.Fatalf("exit code %d", ExitCode(e))
	}
	// A retry changes nothing either.
	_ = recoverErr(t, h.root)
	assertFolders(t, folders(t, h.state), untouched, "retry")
	// The way out the message names: the recreated folder moved aside, then recover.
	aside := filepath.Join(dir, "recreated-aside")
	if err := os.Rename(h.state, aside); err != nil {
		t.Fatal(err)
	}
	got, err := Recover(context.Background(), h.root)
	if err != nil || !got.Recovered || got.Current.Version != "1.0.0" {
		t.Fatalf("%v %+v", err, got)
	}
	assertSnapshot(t, snapshot(t, h.state), h.before, "restored")
	if exists(t, h.journal) {
		t.Fatal("journal kept")
	}
	assertSnapshot(t, snapshot(t, aside), untouched[filepath.Base(h.state)], "aside")
}

func TestStateNotMatchingThePreUpdateCopyWithNoRestoreWaitingIsRefused(t *testing.T) {
	dir := t.TempDir()
	h := haltedRestore(t, dir)
	if err := os.Rename(h.restoring, filepath.Join(dir, "moved-by-hand")); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(h.state, "pglite"), 0o755); err != nil {
		t.Fatal(err)
	}
	untouched := folders(t, h.state)
	e := recoverErr(t, h.root)
	want := "An interrupted update to 1.1.0 could not be rolled back (the state folder " + h.state +
		" cannot be proven restored: it does not match the pre-update copy " + h.pre + "). Do not start SIPGES on this state folder: run --recover to retry, or restore it from the pre-update copy: " + h.pre
	if e.Message != want {
		t.Fatalf("message %q", e.Message)
	}
	if readText(t, h.journal) != h.journalText {
		t.Fatal("journal changed")
	}
	assertFolders(t, folders(t, h.state), untouched, "untouched")
}

func TestRestoredLookingStateWhosePreUpdateCopyIsGoneIsNotProvenRestored(t *testing.T) {
	dir := t.TempDir()
	h := haltedRestore(t, dir)
	if err := os.Rename(h.restoring, h.state); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(h.pre, filepath.Join(dir, "pre-update-moved-by-hand")); err != nil {
		t.Fatal(err)
	}
	untouched := folders(t, h.state)
	e := recoverErr(t, h.root)
	want := "An interrupted update to 1.1.0 could not be rolled back (the state folder " + h.state +
		" cannot be proven restored: the pre-update copy " + h.pre + " is missing). Do not start SIPGES on this state folder: run --recover to retry, or restore it from the pre-update copy: " + h.pre
	if e.Message != want {
		t.Fatalf("message %q", e.Message)
	}
	if readText(t, h.journal) != h.journalText {
		t.Fatal("journal changed")
	}
	assertFolders(t, folders(t, h.state), untouched, "untouched")
}

func TestPreservedHaltedRestoreWithNothingAtTheStateNameStillRecovers(t *testing.T) {
	h := haltedRestore(t, t.TempDir())
	failedBefore, preBefore := snapshot(t, h.failed), snapshot(t, h.pre)
	got, err := Recover(context.Background(), h.root)
	if err != nil || !got.Recovered || got.Current.Version != "1.0.0" {
		t.Fatalf("%v %+v", err, got)
	}
	assertSnapshot(t, snapshot(t, h.state), h.before, "state")
	assertSnapshot(t, snapshot(t, h.failed), failedBefore, "failed")
	assertSnapshot(t, snapshot(t, h.pre), preBefore, "pre")
	if exists(t, h.restoring) || exists(t, h.journal) {
		t.Fatal("restoring copy or journal left")
	}
	if lastLog(t, h.root)["event"] != "recovered" {
		t.Fatal("not logged")
	}
}

func TestPreservedRestoreThatFinishedBeforeItsJournalWasRemovedStillRecovers(t *testing.T) {
	dir := t.TempDir()
	h := haltedRestore(t, dir)
	if err := os.Rename(h.restoring, h.state); err != nil {
		t.Fatal(err)
	}
	failedBefore, preBefore := snapshot(t, h.failed), snapshot(t, h.pre)
	list := names(t, dir)
	got, err := Recover(context.Background(), h.root)
	if err != nil || !got.Recovered {
		t.Fatalf("%v %+v", err, got)
	}
	assertSnapshot(t, snapshot(t, h.state), h.before, "state")
	assertSnapshot(t, snapshot(t, h.failed), failedBefore, "failed")
	assertSnapshot(t, snapshot(t, h.pre), preBefore, "pre")
	if after := names(t, dir); len(after) != len(list) {
		t.Fatalf("names %v -> %v", list, after)
	}
	if exists(t, h.journal) {
		t.Fatal("journal kept")
	}
}

func TestSameNamesAndSizesButOtherContentIsNotProvenRestored(t *testing.T) {
	dir := t.TempDir()
	h := haltedRestore(t, dir)
	if err := os.Rename(h.restoring, filepath.Join(dir, "moved-by-hand")); err != nil {
		t.Fatal(err)
	}
	if err := copyDir(h.pre, h.state); err != nil {
		t.Fatal(err)
	}
	put(t, filepath.Join(h.state, "pglite/base/1/16384"), string(make([]byte, 8192)), 0)
	untouched := folders(t, h.state)
	e := recoverErr(t, h.root)
	if e.Message != "An interrupted update to 1.1.0 could not be rolled back (the state folder "+h.state+
		" cannot be proven restored: it does not match the pre-update copy "+h.pre+"). Do not start SIPGES on this state folder: run --recover to retry, or restore it from the pre-update copy: "+h.pre {
		t.Fatalf("message %q", e.Message)
	}
	assertFolders(t, folders(t, h.state), untouched, "untouched")
}

func TestMissingPreUpdateCopyNeverCostsTheRestoreCopy(t *testing.T) {
	dir := t.TempDir()
	h := haltedRestore(t, dir)
	if err := os.Rename(h.failed, h.state); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(h.pre, filepath.Join(dir, "pre-update-moved-by-hand")); err != nil {
		t.Fatal(err)
	}
	untouched := folders(t, h.state)
	e := recoverErr(t, h.root)
	if e.Message != "An interrupted update to 1.1.0 could not be rolled back (the pre-update copy "+h.pre+
		" is missing; nothing was moved or deleted). Do not start SIPGES on this state folder: run --recover to retry, or restore it from the pre-update copy: "+h.pre {
		t.Fatalf("message %q", e.Message)
	}
	assertSnapshot(t, snapshot(t, h.restoring), h.before, "restoring")
	assertFolders(t, folders(t, h.state), untouched, "untouched")
	if readText(t, h.journal) != h.journalText {
		t.Fatal("journal changed")
	}
}

func TestWayOutOfAHaltAcceptRestoredStateClearsTheUpdate(t *testing.T) {
	dir := t.TempDir()
	f := newFixture(t, dir)
	backup := filepath.Join(dir, "own-backup")
	if err := copyDir(f.state, backup); err != nil {
		t.Fatal(err)
	}
	_, err := f.update(f.release("1.1.0"), func(_ context.Context, target Target) error {
		put(t, filepath.Join(target.StateDir, "pglite/PG_VERSION"), "half migrated\n", 0)
		for _, name := range names(t, filepath.Dir(target.StateDir)) {
			if strings.Contains(name, ".pre-update-") {
				if err := os.RemoveAll(filepath.Join(filepath.Dir(target.StateDir), name)); err != nil {
					return err
				}
			}
		}
		return errors.New("synthetic migration failure")
	}, noop)
	_ = wantCode(t, err, CodeRollbackIncomplete, "wreck")
	journal := filepath.Join(f.root, "update-journal.json")
	pending := readText(t, journal)
	_ = recoverErr(t, f.root)

	if err := os.Rename(f.state, filepath.Join(dir, "half-migrated-aside")); err != nil {
		t.Fatal(err)
	}
	_, err = AcceptRestoredState(context.Background(), f.root)
	e := wantCode(t, err, CodeRefused, "missing")
	if e.Message != "The state folder "+f.state+" does not exist: restore your backup there first" {
		t.Fatalf("message %q", e.Message)
	}
	if err := os.Mkdir(f.state, 0o755); err != nil {
		t.Fatal(err)
	}
	_, err = AcceptRestoredState(context.Background(), f.root)
	e = wantCode(t, err, CodeRefused, "empty")
	if e.Message != "The state folder "+f.state+" is empty: restore your backup there first" {
		t.Fatalf("message %q", e.Message)
	}
	if readText(t, journal) != pending {
		t.Fatal("journal changed")
	}

	if err := os.Remove(f.state); err != nil {
		t.Fatal(err)
	}
	if err := copyDir(backup, f.state); err != nil {
		t.Fatal(err)
	}
	restored := snapshot(t, f.state)
	besides := siblings(t, f.state)
	got, err := AcceptRestoredState(context.Background(), f.root)
	if err != nil || !got.Accepted || got.Current.Version != "1.0.0" {
		t.Fatalf("%v %+v", err, got)
	}
	assertSnapshot(t, snapshot(t, f.state), restored, "accepted as it is")
	if after := siblings(t, f.state); len(after) != len(besides) {
		t.Fatalf("siblings %v -> %v", besides, after)
	}
	if exists(t, journal) {
		t.Fatal("journal kept")
	}
	last := lastLog(t, f.root)
	if last["event"] != "restored-state-accepted" || last["from"] != "1.1.0" || last["to"] != "1.0.0" || last["stateDir"] != f.state {
		t.Fatalf("log %v", last)
	}
	again, err := AcceptRestoredState(context.Background(), f.root)
	if err != nil || again.Accepted {
		t.Fatalf("again %v %+v", err, again)
	}
	if r, err := Recover(context.Background(), f.root); err != nil || r.Recovered {
		t.Fatalf("recover %v %+v", err, r)
	}
}
