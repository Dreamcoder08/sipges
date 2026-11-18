package desktopupdate

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

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
