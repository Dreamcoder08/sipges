package desktopupdate

import (
	"context"
	"os"
	"path/filepath"
	"strconv"
	"testing"
)

// T72d2 verifier blocker B1: a copy of a running PostgreSQL cluster can be torn, and that copy is
// what a restore puts back. FirstStart and Update refuse while <state>/pg18/postmaster.pid names a
// live process, before any journal or copy is written; a pid left by a crashed server does not block.
func livePid() string { return strconv.Itoa(os.Getpid()) + "\n/data\n" }

func TestFirstStartRefusesWhilePostgreSQLRunsOnTheState(t *testing.T) {
	dir := t.TempDir()
	state := filepath.Join(dir, "data", "SIPGES")
	put(t, filepath.Join(state, "pg18", "PG_VERSION"), "18\n", 0)
	put(t, filepath.Join(state, "pg18", "postmaster.pid"), livePid(), 0)
	put(t, filepath.Join(state, "data-key"), "synthetic-key\n", 0o600)
	put(t, filepath.Join(state, "admin-password"), "synthetic-password\n", 0o600)
	f := newFixtureAt(t, dir, state, false)
	var calls []string
	_, err := runFirstStart(f.root, migrating2(&calls), nil)
	_ = wantCode(t, err, CodeRefused, "first start over a running cluster")
	if len(calls) != 0 || exists(t, filepath.Join(f.root, journalName)) {
		t.Fatalf("something ran or was journaled: calls %v", calls)
	}
}

func TestUpdateRefusesWhilePostgreSQLRunsOnTheState(t *testing.T) {
	dir := t.TempDir()
	f := newFixture(t, dir)
	put(t, filepath.Join(f.state, "pg18", "PG_VERSION"), "18\n", 0)
	put(t, filepath.Join(f.state, "pg18", "postmaster.pid"), livePid(), 0)
	_, err := f.update(f.release("1.1.0"), noop, noop)
	_ = wantCode(t, err, CodeRefused, "update over a running cluster")
	if exists(t, filepath.Join(f.root, journalName)) {
		t.Fatal("a journal was written")
	}
}

func TestAPidFileOfACrashedServerDoesNotBlockTheUpdate(t *testing.T) {
	dir := t.TempDir()
	f := newFixture(t, dir)
	put(t, filepath.Join(f.state, "pg18", "PG_VERSION"), "18\n", 0)
	put(t, filepath.Join(f.state, "pg18", "postmaster.pid"), "2147483646\n/data\n", 0)
	if _, err := f.update(f.release("1.1.0"), noop, noop); err != nil {
		t.Fatalf("update with a stale postmaster.pid: %v", err)
	}
}

// T72d2 verifier advisory A1: a journal of null is no journal (as in Node), and a journal without a
// version to go back to or an absolute state folder is CORRUPT, never a pointer rewritten empty.
func TestANullJournalIsNoJournalAndAnEmptyOneIsCorrupt(t *testing.T) {
	dir := t.TempDir()
	f := newFixture(t, dir)
	pointer := filepath.Join(f.root, pointerName)
	before, err := os.ReadFile(pointer)
	if err != nil {
		t.Fatal(err)
	}
	put(t, filepath.Join(f.root, journalName), "null", 0)
	if _, err := Recover(context.Background(), f.root); err != nil {
		t.Fatalf("recover with a null journal: %v", err)
	}
	put(t, filepath.Join(f.root, journalName), "{}", 0)
	_, err = Recover(context.Background(), f.root)
	_ = wantCode(t, err, CodeCorrupt, "recover with an empty journal")
	after, _ := os.ReadFile(pointer)
	if string(after) != string(before) || !exists(t, filepath.Join(f.root, journalName)) {
		t.Fatalf("pointer or journal changed: %s", after)
	}
}
