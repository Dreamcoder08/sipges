package desktopsnapshot

import (
	"errors"
	"io"
	"os"
	"path/filepath"
	"testing"
)

// A write that fails half-way leaves neither the --out file nor a scratch file behind, and a
// finished one never replaces an existing file.
func TestWriteNewNeverLeavesAPartialFile(t *testing.T) {
	dir := t.TempDir()
	out := filepath.Join(dir, "after.json")
	saved := writeText
	t.Cleanup(func() { writeText = saved })
	writeText = func(w io.Writer, text string) error {
		_, _ = io.WriteString(w, text[:3])
		return errors.New("disk full")
	}
	if err := writeNew(out, "{\n  \"x\": 1\n}\n"); err == nil || err.Error() != "disk full" {
		t.Fatalf("the failed write: %v", err)
	}
	if left, _ := os.ReadDir(dir); len(left) != 0 {
		t.Fatalf("a failed write left %v", left)
	}
	writeText = saved
	if err := writeNew(out, "first\n"); err != nil {
		t.Fatal(err)
	}
	if err := writeNew(out, "second\n"); !errors.Is(err, os.ErrExist) {
		t.Fatalf("an existing --out was not refused: %v", err)
	}
	if b, _ := os.ReadFile(out); string(b) != "first\n" {
		t.Fatalf("the existing file changed: %q", b)
	}
	if left, _ := os.ReadDir(dir); len(left) != 1 {
		t.Fatalf("scratch files left: %v", left)
	}
	if info, _ := os.Stat(out); filepath.Separator == '/' && info.Mode().Perm() != 0o600 {
		t.Fatalf("mode %v", info.Mode())
	}
}
