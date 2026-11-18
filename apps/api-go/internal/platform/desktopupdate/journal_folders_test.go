package desktopupdate

import (
	"path/filepath"
	"slices"
	"testing"
)

// JournalFolders names the state folder and every copy a pending journal names, so a launcher
// can stop a PostgreSQL left running on any of them before recovery renames or deletes one.
func TestJournalFoldersNamesEveryFolderOfAPendingJournal(t *testing.T) {
	root := t.TempDir()
	if got, err := JournalFolders(root); err != nil || got != nil {
		t.Fatalf("without a journal: %v %v", got, err)
	}
	state := filepath.Join(t.TempDir(), "state")
	j := journal{
		From: journalFrom{Version: "1.0.0", Path: "versions/1.0.0"}, To: journalTo{Version: "1.1.0", Path: "versions/1.1.0"},
		StateDir: state, PreCopy: state + ".pre-update-x", FailedAside: state + ".failed-x", Restoring: "", Phase: "migrating",
	}
	if err := saveJournal(root, j); err != nil {
		t.Fatal(err)
	}
	got, err := JournalFolders(root)
	if err != nil {
		t.Fatal(err)
	}
	if want := []string{state, state + ".pre-update-x", state + ".failed-x"}; !slices.Equal(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}
