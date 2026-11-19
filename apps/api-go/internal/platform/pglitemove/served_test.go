package pglitemove

import (
	"crypto/rand"
	neturl "net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// Review of #539, ported from #547: --prepared must name the folder whose pg18 the target serves;
// any other folder keeps its mark, and nothing is read or written. The API's login reads no
// data_directory, so the cluster is told by its system identifier (global/pg_control) and the
// port in its postmaster.pid.
func TestRefusesPreparedWhosePg18TheTargetDoesNotServeWritingNothing(t *testing.T) {
	server(t)
	live := filepath.Join(shared.dir, "pg18")
	empty := preparedWith(t, "")
	forged := preparedWith(t, "")
	if err := os.MkdirAll(filepath.Join(forged, "pg18", "global"), 0o700); err != nil {
		t.Fatal(err)
	}
	control := make([]byte, 8192)
	_, _ = rand.Read(control)
	writeFile(t, filepath.Join(forged, "pg18", "global", "pg_control"), control)
	writeFile(t, filepath.Join(forged, "pg18", "postmaster.pid"), readFile(t, filepath.Join(live, "postmaster.pid")))
	// The right system identifier but another port: the server is not the one on that folder.
	wrongPort := preparedWith(t, "")
	if err := os.MkdirAll(filepath.Join(wrongPort, "pg18", "global"), 0o700); err != nil {
		t.Fatal(err)
	}
	writeFile(t, filepath.Join(wrongPort, "pg18", "global", "pg_control"), readFile(t, filepath.Join(live, "global", "pg_control")))
	pid := strings.Split(string(readFile(t, filepath.Join(live, "postmaster.pid"))), "\n")
	pid[3] = "1"
	writeFile(t, filepath.Join(wrongPort, "pg18", "postmaster.pid"), []byte(strings.Join(pid, "\n")))
	for name, state := range map[string]string{"empty": empty, "forged": forged, "wrong port": wrongPort} {
		t.Run(name, func(t *testing.T) {
			url, _ := target(t)
			scratch := t.TempDir()
			code, out := move(t, Options{State: copyOf(t), To: url, Prepared: state, Scratch: scratch}, Hooks{})
			assertNotServed(t, code, out, state, url, scratch)
		})
	}
}

func TestWithDataDirectoryReadableACopyOfTheServedPg18ElsewhereIsStillRefused(t *testing.T) {
	server(t)
	live := filepath.Join(shared.dir, "pg18")
	state := preparedWith(t, "")
	if err := os.MkdirAll(filepath.Join(state, "pg18", "global"), 0o700); err != nil {
		t.Fatal(err)
	}
	writeFile(t, filepath.Join(state, "pg18", "global", "pg_control"), readFile(t, filepath.Join(live, "global", "pg_control")))
	writeFile(t, filepath.Join(state, "pg18", "postmaster.pid"), readFile(t, filepath.Join(live, "postmaster.pid")))
	url, _ := target(t)
	u, err := neturl.Parse(url)
	if err != nil {
		t.Fatal(err)
	}
	adminExec(t, "postgres", "GRANT pg_read_all_settings TO "+u.User.Username())
	scratch := t.TempDir()
	code, out := move(t, Options{State: copyOf(t), To: url, Prepared: state, Scratch: scratch}, Hooks{})
	assertNotServed(t, code, out, state, url, scratch)

	// The folder the server does serve, through a link: data_directory resolves to it.
	served := prepared(t)
	code, out = move(t, Options{State: copyOf(t), To: url, Prepared: served}, Hooks{})
	if code != ExitMoved {
		t.Fatalf("exit %d, want 0:\n%s", code, out)
	}
	if _, err := os.Lstat(filepath.Join(served, PendingMoveName)); !os.IsNotExist(err) {
		t.Errorf("the mark of the served folder is still there: %v", err)
	}
}

func assertNotServed(t *testing.T, code int, out, state, url, scratch string) {
	t.Helper()
	if code != ExitNotMoved {
		t.Fatalf("exit %d, want 2:\n%s", code, out)
	}
	mustMatch(t, out,
		`RESULT: not moved: el servidor de destino no sirve la carpeta .*pg18 de --prepared: indique la carpeta de datos que preparó sipges-desktop --prepare-only y arranque su clúster; no se escribió nada\n$`)
	if strings.Contains(out, "Source:") {
		t.Errorf("the copy was read before the refusal:\n%s", out)
	}
	if _, err := os.Lstat(filepath.Join(state, PendingMoveName)); err != nil {
		t.Errorf("another folder lost its mark: %v", err)
	}
	if n := tableCount(t, url); n != 0 {
		t.Errorf("the target was written: %d tables", n)
	}
	if list, _ := os.ReadDir(scratch); len(list) != 0 {
		t.Errorf("the scratch folder was written: %d entries", len(list))
	}
}

func TestTheRemovalCommandQuotesTheMarkForPowerShellAndSh(t *testing.T) {
	if got, want := removeCommand(`C:\Users\O'Neil\SIPGES\pg18.pending-move`, "windows"), `Remove-Item -LiteralPath 'C:\Users\O''Neil\SIPGES\pg18.pending-move'`; got != want {
		t.Errorf("windows: %s, want %s", got, want)
	}
	if got, want := removeCommand(`/home/o'neil/pg18.pending-move`, "linux"), `rm -- '/home/o'\''neil/pg18.pending-move'`; got != want {
		t.Errorf("linux: %s, want %s", got, want)
	}
}

func TestAMarkThatCannotBeRemovedAfterTheCommitExits2AndPrintsTheCommand(t *testing.T) {
	if runtime.GOOS == "windows" || os.Geteuid() == 0 {
		t.Skip("a read-only folder still lets this user remove the mark")
	}
	state := prepared(t)
	if err := os.Chmod(state, 0o555); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(state, 0o755) })
	url, _ := target(t)
	code, out := move(t, Options{State: copyOf(t), To: url, Prepared: state}, Hooks{})
	if code != ExitNotMoved {
		t.Fatalf("exit %d, want 2:\n%s", code, out)
	}
	mark := filepath.Join(state, PendingMoveName)
	mustMatch(t, out, `Moved: the target holds the copy, committed\.`)
	if !strings.Contains(out, "\n  rm -- '"+mark+"'\n") {
		t.Errorf("the output does not print the command that removes the mark:\n%s", out)
	}
	if n := tableCount(t, url); n == 0 {
		t.Error("the move did not commit")
	}
	if _, err := os.Lstat(mark); err != nil {
		t.Errorf("the mark is gone: %v", err)
	}
}

func writeFile(t *testing.T, path string, data []byte) {
	t.Helper()
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
}

func readFile(t *testing.T, path string) []byte {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return data
}
