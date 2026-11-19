package pglitemove

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// fakeState is a folder that passes for a state folder up to the point a database is read:
// pglite/PG_VERSION only. Every refusal below happens before anything is read.
func fakeState(t *testing.T, dir string) string {
	t.Helper()
	if err := os.MkdirAll(filepath.Join(dir, "pglite"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "pglite", "PG_VERSION"), []byte("18\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	return dir
}

const unreachable = "postgres://nobody@127.0.0.1:1/none"

// refusedRun runs the move with nothing reachable and returns the exit code and output.
func refusedRun(t *testing.T, o Options, h Hooks) (int, string) {
	t.Helper()
	if o.To == "" {
		o.To = unreachable
	}
	if h.Answers == nil {
		h.Answers = func(int) bool { return false }
	}
	var out strings.Builder
	code := Run(context.Background(), o, &out, h)
	return code, out.String()
}

func TestOriginalStateIsSipgesLocalOnLinuxAndSIPGESOnWindows(t *testing.T) {
	env := func(m map[string]string) func(string) (string, bool) {
		return func(k string) (string, bool) { v, ok := m[k]; return v, ok }
	}
	if got := OriginalState(env(map[string]string{"HOME": "/home/u"}), "linux", "/x"); got != filepath.Join("/home/u", ".local", "share", "sipges-local") {
		t.Errorf("linux: %s", got)
	}
	if got := OriginalState(env(map[string]string{"LOCALAPPDATA": `C:\Users\u\AppData\Local`}), "windows", `C:\Users\u`); got != `C:\Users\u\AppData\Local\SIPGES` {
		t.Errorf("windows: %s", got)
	}
	if got := OriginalState(env(nil), "windows", `C:\Users\u`); got != `C:\Users\u\AppData\Local\SIPGES` {
		t.Errorf("windows without LOCALAPPDATA: %s", got)
	}
}

func TestRefusesTheOriginalStateFolderAndLeavesItAsItWas(t *testing.T) {
	home := t.TempDir()
	original := fakeState(t, filepath.Join(home, ".local", "share", "sipges-local"))
	before := digest(t, filepath.Join(original, "pglite"))
	for _, given := range []string{original, original + string(filepath.Separator) + ".", filepath.Join(original, "..", "sipges-local"), filepath.Join(original, "pglite")} {
		code, out := refusedRun(t, Options{State: given, Originals: []string{original}}, Hooks{})
		if code != ExitNotMoved || !strings.Contains(out, "original state folder") {
			t.Errorf("--state %s: exit %d\n%s", given, code, out)
		}
	}
	if after := digest(t, filepath.Join(original, "pglite")); after != before {
		t.Error("the original folder changed")
	}
}

func TestRefusesLinksToACopyOrToTheOriginalAndALinkedPgliteFolder(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symbolic links need a privilege on Windows")
	}
	root := t.TempDir()
	original := fakeState(t, filepath.Join(root, "home", ".local", "share", "sipges-local"))
	copyDir := fakeState(t, filepath.Join(root, "copy"))
	for _, l := range [][2]string{{copyDir, "link-to-copy"}, {original, "link-to-original"}} {
		if err := os.Symlink(l[0], filepath.Join(root, l[1])); err != nil {
			t.Fatal(err)
		}
		code, out := refusedRun(t, Options{State: filepath.Join(root, l[1]), Originals: []string{original}}, Hooks{})
		if code != ExitNotMoved || !strings.Contains(out, "is a link or junction") {
			t.Errorf("%s: exit %d\n%s", l[1], code, out)
		}
	}
	inner := filepath.Join(root, "inner")
	if err := os.Mkdir(inner, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(original, "pglite"), filepath.Join(inner, "pglite")); err != nil {
		t.Fatal(err)
	}
	code, out := refusedRun(t, Options{State: inner, Originals: []string{original}}, Hooks{})
	if code != ExitNotMoved || !strings.Contains(out, "holds pglite as a link or junction") {
		t.Errorf("inner link: exit %d\n%s", code, out)
	}
	// A link inside the copy's pglite folder is refused when it is hashed, before any copy.
	if err := os.Symlink("/etc/hostname", filepath.Join(copyDir, "pglite", "linked")); err != nil {
		t.Fatal(err)
	}
	code, out = refusedRun(t, Options{State: copyDir}, Hooks{})
	if code != ExitNotMoved || !strings.Contains(out, "holds a link, junction or special file (linked)") {
		t.Errorf("link inside pglite: exit %d\n%s", code, out)
	}
}

func TestRefusesATargetNotOn127001BeforeReadingTheSource(t *testing.T) {
	copyDir := fakeState(t, filepath.Join(t.TempDir(), "copy"))
	for _, url := range []string{
		"postgres://u:pw@db.example:5432/x",
		"postgres://u@127.0.0.1:5432/x?host=/tmp",
		"postgres://u@127.0.0.1:5432/x?hostaddr=10.0.0.1",
		"postgres://u@127.0.0.1:5432/",
		"mysql://u@127.0.0.1:5432/x",
		"not a url",
		"",
	} {
		o := Options{State: copyDir, To: url}
		if url == "" {
			o.To = ""
		}
		var out strings.Builder
		code := Run(context.Background(), o, &out, Hooks{Answers: func(int) bool { return false }})
		if code != ExitNotMoved || !strings.Contains(out.String(), "127.0.0.1") {
			t.Errorf("%q: exit %d\n%s", url, code, out.String())
		}
		if strings.Contains(out.String(), "db.example") || strings.Contains(out.String(), "pw") {
			t.Errorf("the URL was printed: %s", out.String())
		}
	}
}

func TestRefusesScratchInsideTheOriginalOrTheCopyBeforeCreatingAnything(t *testing.T) {
	root := t.TempDir()
	original := fakeState(t, filepath.Join(root, "sipges-local"))
	copyDir := fakeState(t, filepath.Join(root, "copy"))
	for _, c := range []struct{ scratch, why string }{
		{filepath.Join(original, "pglite"), "inside the original state folder"},
		{original, "inside the original state folder"},
		{filepath.Join(copyDir, "pglite"), "inside the copy"},
		{filepath.Join(root, "missing"), "does not exist"},
	} {
		code, out := refusedRun(t, Options{State: copyDir, Scratch: c.scratch, Originals: []string{original}}, Hooks{})
		if code != ExitNotMoved || !strings.Contains(out, c.why) {
			t.Errorf("--scratch %s: exit %d\n%s", c.scratch, code, out)
		}
	}
	for _, dir := range []string{filepath.Join(original, "pglite"), filepath.Join(copyDir, "pglite")} {
		list, _ := os.ReadDir(dir)
		if len(list) != 1 {
			t.Errorf("%s holds %d entries, want only PG_VERSION", dir, len(list))
		}
	}
}

func TestRefusesACopyTakenWhileSIPGESRanInSpanish(t *testing.T) {
	copyDir := fakeState(t, filepath.Join(t.TempDir(), "copy"))
	pid := filepath.Join(copyDir, "pglite", "postmaster.pid")
	if err := os.WriteFile(pid, []byte("-42\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	code, out := refusedRun(t, Options{State: copyDir}, Hooks{})
	if code != ExitNotMoved || !strings.Contains(out, "cierre SIPGES y copie la carpeta otra vez") {
		t.Errorf("fresh postmaster.pid: exit %d\n%s", code, out)
	}
	old := time.Now().Add(-3 * time.Minute)
	if err := os.Chtimes(pid, old, old); err != nil {
		t.Fatal(err)
	}
	code, out = refusedRun(t, Options{State: copyDir, Port: 8123}, Hooks{Answers: func(p int) bool { return p == 8123 }})
	if code != ExitNotMoved || !strings.Contains(out, "SIPGES responde en el puerto 8123") {
		t.Errorf("answering port: exit %d\n%s", code, out)
	}
}

func TestRefusesPreparedWithoutThePendingMarkBeforeReadingAnything(t *testing.T) {
	root := t.TempDir()
	copyDir := fakeState(t, filepath.Join(root, "copy"))
	code, out := refusedRun(t, Options{State: copyDir, Prepared: filepath.Join(root, "unmarked")}, Hooks{})
	if code != ExitNotMoved || !strings.Contains(out, "RESULT: not moved: --prepared names no folder that sipges-desktop --prepare-only prepared (no pg18.pending-move)") {
		t.Errorf("exit %d\n%s", code, out)
	}
}

func TestRefusesAMissingOrUnpinnedDistAndAMissingPgDump(t *testing.T) {
	root := t.TempDir()
	copyDir := fakeState(t, filepath.Join(root, "copy"))
	wrong := filepath.Join(root, "dist")
	if err := os.Mkdir(wrong, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(wrong, "pglite.wasm"), []byte("not the pinned file"), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, c := range []struct {
		dist, why string
	}{
		{"", "the PGlite 0.5.15 dist folder is required"},
		{filepath.Join(root, "none"), "is not the pinned @electric-sql/pglite 0.5.15 dist folder"},
		{wrong, "pglite.wasm has sha256"},
	} {
		code, out := refusedRun(t, Options{State: copyDir, PGliteDist: c.dist}, Hooks{})
		if code != ExitNotMoved || !strings.Contains(out, c.why) {
			t.Errorf("dist %q: exit %d\n%s", c.dist, code, out)
		}
	}
	if dist := os.Getenv("SIPGES_PGLITE_DIST"); dist != "" {
		for _, c := range []struct{ bin, why string }{
			{"", "the PostgreSQL 18 bin folder (pg_dump) is required"},
			{root, "no pg_dump of PostgreSQL 18 in --pg-bin"},
		} {
			code, out := refusedRun(t, Options{State: copyDir, PGliteDist: dist, PGBin: c.bin}, Hooks{})
			if code != ExitNotMoved || !strings.Contains(out, c.why) {
				t.Errorf("pg-bin %q: exit %d\n%s", c.bin, code, out)
			}
		}
	}
}

func TestRefusesAMissingStateAndAnInvalidPort(t *testing.T) {
	code, out := refusedRun(t, Options{}, Hooks{})
	if code != ExitNotMoved || !strings.Contains(out, "RESULT: not moved: --state <copy of the state folder> is required") {
		t.Errorf("no state: exit %d\n%s", code, out)
	}
	code, out = refusedRun(t, Options{State: t.TempDir(), Port: 70000}, Hooks{})
	if code != ExitNotMoved || !strings.Contains(out, "RESULT: not moved: invalid --port") {
		t.Errorf("port: exit %d\n%s", code, out)
	}
}

func TestStopSignalRemovesNothingItself(t *testing.T) {
	work := t.TempDir()
	var said strings.Builder
	s := &Stop{work: work}
	s.Signal(&said)
	if !s.requested {
		t.Error("the stop was not recorded")
	}
	if _, err := os.Stat(work); err != nil {
		t.Errorf("the handler removed the scratch copy itself: %v", err)
	}
	if !strings.Contains(said.String(), "wait for the RESULT line") {
		t.Errorf("said %q", said.String())
	}
	said.Reset()
	(&Stop{committing: true}).Signal(&said)
	if strings.Contains(strings.ToLower(said.String()), "nothing was committed") {
		t.Errorf("a stop while committing claims nothing was committed: %q", said.String())
	}
}

func TestStripRestrictRemovesOnlyTheMatchingPair(t *testing.T) {
	dump := "--\n-- PostgreSQL database dump\n--\n\n\\restrict AbC123\n\nSET x = 1;\nINSERT INTO t VALUES ('\\restrict AbC123');\n\n\\unrestrict AbC123\n\n"
	got, err := stripRestrict(dump)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(got, "\n\\restrict") || strings.Contains(got, "\\unrestrict") {
		t.Errorf("a meta-command is left:\n%s", got)
	}
	if !strings.Contains(got, "INSERT INTO t VALUES ('\\restrict AbC123');") {
		t.Errorf("a data line was touched:\n%s", got)
	}
	for _, bad := range []string{
		"\\restrict AbC123\nSET x = 1;\n\\unrestrict Other\n",
		"\\restrict AbC123\nSET x = 1;\n",
		"\\connect other\nSET x = 1;\n",
	} {
		if _, err := stripRestrict(bad); err == nil {
			t.Errorf("accepted %q", bad)
		}
	}
	if got, err := stripRestrict("SET x = 1;\n"); err != nil || got != "SET x = 1;\n" {
		t.Errorf("a dump without meta-commands changed: %q %v", got, err)
	}
}
