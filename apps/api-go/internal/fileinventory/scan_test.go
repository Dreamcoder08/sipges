package fileinventory

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

var olePrefix = []byte{0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1, 0, 0, 0, 0}

func put(t *testing.T, root, name string, body []byte) {
	t.Helper()
	path := filepath.Join(root, name)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, body, 0o644); err != nil {
		t.Fatal(err)
	}
}

func zipped(t *testing.T, parts map[string]string) []byte {
	t.Helper()
	var buf bytes.Buffer
	w := zip.NewWriter(&buf)
	for name, body := range parts {
		f, err := w.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := f.Write([]byte(body)); err != nil {
			t.Fatal(err)
		}
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func scan(t *testing.T, root string) Report {
	t.Helper()
	report, err := Scan(context.Background(), root, Options{Now: func() time.Time { return time.Unix(0, 0).UTC() }})
	if err != nil {
		t.Fatal(err)
	}
	return report
}

func file(t *testing.T, r Report, path string) File {
	t.Helper()
	for _, f := range r.Files {
		if f.Path == path {
			return f
		}
	}
	t.Fatalf("no %s in %+v", path, r.Files)
	return File{}
}

func TestCountsPerType(t *testing.T) {
	root := t.TempDir()
	put(t, root, "a/one.PDF", []byte("%PDF-1.7\nbody\n%%EOF\n"))
	put(t, root, "two.pdf", []byte("%PDF-1.4\nother body\n%%EOF\n"))
	put(t, root, "photo.jpg", []byte{0xFF, 0xD8, 0xFF})
	put(t, root, "no-extension", []byte("x"))

	r := scan(t, root)

	if r.Schema != Schema || r.GeneratedAt.Unix() != 0 {
		t.Errorf("header: %+v", r)
	}
	want := map[string]TypeCount{
		"pdf":    {Type: "pdf", Files: 2, Bytes: 46, Readable: 2},
		"jpg":    {Type: "jpg", Files: 1, Bytes: 3, NotInspected: 1},
		"(none)": {Type: "(none)", Files: 1, Bytes: 1, NotInspected: 1},
	}
	if len(r.ByType) != len(want) {
		t.Fatalf("types: %+v", r.ByType)
	}
	for _, got := range r.ByType {
		if got != want[got.Type] {
			t.Errorf("%s: got %+v, want %+v", got.Type, got, want[got.Type])
		}
	}
	if r.Totals.Files != 4 || r.Totals.Bytes != 50 || r.Totals.Readable != 2 || r.Totals.NotInspected != 2 {
		t.Errorf("totals: %+v", r.Totals)
	}
	if file(t, r, "a/one.PDF").Type != "pdf" {
		t.Error("the path must keep its case and the type must not")
	}
}

func TestAnExtensionThatIsNotOneBecomesOther(t *testing.T) {
	root := t.TempDir()
	put(t, root, "report.Synthetic Person Name", []byte("x"))
	r := scan(t, root)
	if got := r.Files[0].Type; got != "other" {
		t.Errorf("type %q: a file name must not become a report column", got)
	}
}

func TestDuplicatesByHash(t *testing.T) {
	root := t.TempDir()
	same := []byte("%PDF-1.7\nsame body\n%%EOF\n")
	put(t, root, "first.pdf", same)
	put(t, root, "folder/copy.pdf", same)
	put(t, root, "renamed.bin", same)
	put(t, root, "unique.pdf", []byte("%PDF-1.7\nanother\n%%EOF\n"))
	put(t, root, "empty-1.txt", nil)
	put(t, root, "empty-2.txt", nil)

	r := scan(t, root)

	if len(r.Duplicates) != 1 {
		t.Fatalf("duplicates: %+v", r.Duplicates)
	}
	d := r.Duplicates[0]
	if strings.Join(d.Paths, ",") != "first.pdf,folder/copy.pdf,renamed.bin" || d.Bytes != int64(len(same)) || len(d.SHA256) != 64 {
		t.Errorf("group: %+v", d)
	}
	if r.Totals.DuplicateFiles != 2 || r.Totals.DuplicateBytes != 2*int64(len(same)) {
		t.Errorf("totals: %+v", r.Totals)
	}
}

func TestReadability(t *testing.T) {
	word := zipped(t, map[string]string{"word/document.xml": "<w:document/>"})
	cases := []struct {
		name   string
		body   []byte
		status Status
		reason string
	}{
		{"fine.pdf", []byte("%PDF-1.7\nbody\n%%EOF\n"), StatusReadable, ""},
		{"locked.pdf", []byte("%PDF-1.7\ntrailer << /Encrypt 5 0 R >>\n%%EOF\n"), StatusUnreadable, ReasonEncrypted},
		{"cut.pdf", []byte("%PDF-1.7\nbody without an end"), StatusUnreadable, ReasonCorrupt},
		{"fake.pdf", []byte("<html>not a pdf</html>"), StatusUnreadable, ReasonCorrupt},
		{"fine.docx", word, StatusReadable, ""},
		{"macros.docm", word, StatusReadable, ""},
		{"locked.docx", olePrefix, StatusUnreadable, ReasonEncrypted},
		{"no-body.docx", zipped(t, map[string]string{"other.xml": "<a/>"}), StatusUnreadable, ReasonCorrupt},
		{"cut.docx", word[:len(word)/2], StatusUnreadable, ReasonCorrupt},
		{"old.doc", olePrefix, StatusUnreadable, ReasonLegacyFormat},
		{"old.xls", olePrefix, StatusUnreadable, ReasonLegacyFormat},
		{"fake.xls", []byte("<table/>"), StatusUnreadable, ReasonCorrupt},
		{"empty.pdf", nil, StatusUnreadable, ReasonEmpty},
		{"empty.png", nil, StatusUnreadable, ReasonEmpty},
		{"picture.png", []byte{0x89, 'P', 'N', 'G'}, StatusNotInspected, ""},
	}
	root := t.TempDir()
	for _, c := range cases {
		put(t, root, c.name, c.body)
	}
	r := scan(t, root)
	for _, c := range cases {
		got := file(t, r, c.name)
		if got.Status != c.status || got.Reason != c.reason {
			t.Errorf("%s: got %s/%s, want %s/%s", c.name, got.Status, got.Reason, c.status, c.reason)
		}
	}
}

func TestLinksAreNeverFollowed(t *testing.T) {
	outside := t.TempDir()
	put(t, outside, "secret.pdf", []byte("%PDF-1.7\nsecret\n%%EOF\n"))
	root := t.TempDir()
	if err := os.Symlink(filepath.Join(outside, "secret.pdf"), filepath.Join(root, "link.pdf")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "linked-folder")); err != nil {
		t.Fatal(err)
	}
	r := scan(t, root)
	if len(r.Files) != 2 {
		t.Fatalf("files: %+v", r.Files)
	}
	for _, f := range r.Files {
		if f.Status != StatusUnreadable || f.Reason != ReasonLink || f.SHA256 != "" || f.Type != "(link)" {
			t.Errorf("%+v", f)
		}
	}
}

func TestSpecialFilesAreNeverOpened(t *testing.T) {
	root := t.TempDir()
	if err := syscall.Mkfifo(filepath.Join(root, "pipe.csv"), 0o644); err != nil {
		t.Skip(err)
	}
	done := make(chan Report, 1)
	go func() { done <- scan(t, root) }()
	select {
	case r := <-done:
		if got := file(t, r, "pipe.csv"); got.Reason != ReasonSpecialFile {
			t.Errorf("%+v", got)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the scan opened a pipe and blocked on it")
	}
}

func TestPermissionDeniedIsReportedAndTheScanGoesOn(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root reads everything")
	}
	root := t.TempDir()
	put(t, root, "closed/inside.pdf", []byte("%PDF-1.7\n%%EOF\n"))
	put(t, root, "locked.pdf", []byte("%PDF-1.7\n%%EOF\n"))
	put(t, root, "open.pdf", []byte("%PDF-1.7\n%%EOF\n"))
	if err := os.Chmod(filepath.Join(root, "locked.pdf"), 0); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(filepath.Join(root, "closed"), 0); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(filepath.Join(root, "closed"), 0o755) })

	r := scan(t, root)

	if got := file(t, r, "locked.pdf"); got.Reason != ReasonPermissionDenied {
		t.Errorf("%+v", got)
	}
	if got := file(t, r, "closed"); got.Reason != ReasonPermissionDenied || got.Type != "(folder)" {
		t.Errorf("%+v", got)
	}
	if got := file(t, r, "open.pdf"); got.Status != StatusReadable {
		t.Errorf("%+v", got)
	}
}

func TestAFolderThatDoesNotExistIsAnError(t *testing.T) {
	if _, err := Scan(context.Background(), filepath.Join(t.TempDir(), "missing"), Options{}); err == nil {
		t.Fatal("no error")
	}
}

func TestACancelledScanStops(t *testing.T) {
	root := t.TempDir()
	put(t, root, "a.pdf", []byte("%PDF-1.7\n%%EOF\n"))
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := Scan(ctx, root, Options{}); err == nil {
		t.Fatal("no error")
	}
}

// The folder holds a client's originals: not one byte, name, mode or time may move, and a folder
// mounted read-only must be enough.
func TestTheFolderIsOnlyRead(t *testing.T) {
	root := t.TempDir()
	put(t, root, "a/doc.docx", zipped(t, map[string]string{"word/document.xml": "<w:document/>"}))
	put(t, root, "report.pdf", []byte("%PDF-1.7\n%%EOF\n"))
	snapshot := func() string {
		var out strings.Builder
		err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
			if err != nil {
				return err
			}
			info, err := d.Info()
			if err != nil {
				return err
			}
			var body []byte
			if !d.IsDir() {
				if body, err = os.ReadFile(path); err != nil {
					return err
				}
			}
			out.WriteString(path + info.Mode().String() + info.ModTime().String() + string(body) + "\n")
			return nil
		})
		if err != nil {
			t.Fatal(err)
		}
		return out.String()
	}
	if err := os.Chmod(filepath.Join(root, "a"), 0o555); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(filepath.Join(root, "a"), 0o755) })
	before := snapshot()
	scan(t, root)
	if snapshot() != before {
		t.Fatal("the scan changed the folder")
	}
}

func TestReportIsStableAcrossRuns(t *testing.T) {
	root := t.TempDir()
	put(t, root, "b.pdf", []byte("%PDF-1.7\n%%EOF\n"))
	put(t, root, "a.png", []byte{1})
	first, _ := json.Marshal(scan(t, root))
	second, _ := json.Marshal(scan(t, root))
	if !bytes.Equal(first, second) {
		t.Fatal("two runs on one folder differ")
	}
}

func TestSummaryNamesNoFile(t *testing.T) {
	root := t.TempDir()
	put(t, root, "Synthetic Person.pdf", []byte("%PDF-1.7\n%%EOF\n"))
	put(t, root, "Synthetic Person copy.pdf", []byte("%PDF-1.7\n%%EOF\n"))
	put(t, root, "Synthetic Locked.docx", olePrefix)
	var out bytes.Buffer
	scan(t, root).WriteSummary(&out)
	text := out.String()
	if strings.Contains(text, "Synthetic") {
		t.Fatalf("a name reached the terminal:\n%s", text)
	}
	for _, want := range []string{"3 files", "pdf", "docx", "encrypted", "1 group"} {
		if !strings.Contains(text, want) {
			t.Errorf("no %q in:\n%s", want, text)
		}
	}
}
