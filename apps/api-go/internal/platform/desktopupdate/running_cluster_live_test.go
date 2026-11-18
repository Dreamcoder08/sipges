package desktopupdate

import (
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"testing"
)

// sleeperEnv makes this test binary sleep until it is killed (TestMain), standing for a process a
// postmaster.pid names.
const sleeperEnv = "SIPGES_DESKTOPUPDATE_TEST_SLEEPER"

// sleeper starts this test binary, or a copy of it named name, sleeping in dir.
func sleeper(t *testing.T, name, dir string) int {
	t.Helper()
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	program := self
	if name != "" {
		if runtime.GOOS == "windows" {
			name += ".exe"
		}
		program = filepath.Join(t.TempDir(), name)
		copyProgram(t, self, program)
	}
	cmd := exec.Command(program)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), sleeperEnv+"=1")
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = cmd.Process.Kill(); _ = cmd.Wait() })
	return cmd.Process.Pid
}

func copyProgram(t *testing.T, src, dst string) {
	t.Helper()
	if os.Link(src, dst) == nil {
		return
	}
	in, err := os.Open(src)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = in.Close() }()
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_EXCL, 0o700)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := io.Copy(out, in); err != nil {
		t.Fatal(err)
	}
	if err := out.Close(); err != nil {
		t.Fatal(err)
	}
}

// silentPort accepts connections and never answers, as a frozen or slow PostgreSQL does.
func silentPort(t *testing.T) int {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	var conns []net.Conn
	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			conns = append(conns, conn)
		}
	}()
	t.Cleanup(func() {
		_ = ln.Close()
		<-done
		for _, c := range conns {
			_ = c.Close()
		}
	})
	return ln.Addr().(*net.TCPAddr).Port
}

// frozenPostgres stands for a PostgreSQL serving <state>/pg18 that does not answer its port
// (frozen, starting up, or held by an antivirus): a program named postgres working in that folder,
// named by its postmaster.pid, whose port accepts and stays silent.
func frozenPostgres(t *testing.T, state string) {
	t.Helper()
	dataDir := filepath.Join(state, clusterDir)
	pid := sleeper(t, "postgres", dataDir)
	put(t, filepath.Join(dataDir, "postmaster.pid"), pidFile(pid, dataDir, silentPort(t)), 0)
}

func pidFile(pid int, dataDir string, port int) string {
	return strconv.Itoa(pid) + "\n" + dataDir + "\n1700000000\n" + strconv.Itoa(port) + "\n\n127.0.0.1\n  0  0\nready   \n"
}

func closedPort(t *testing.T) int {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	_ = ln.Close()
	return port
}

// T72d2 verifier blocker B1 and PR #540 blocker: a copy of a running PostgreSQL cluster can be
// torn, and that copy is what a restore puts back. FirstStart and Update refuse while PostgreSQL
// serves <state>/pg18, even one that does not answer its port, before any journal or copy is
// written.
func TestFirstStartRefusesWhilePostgreSQLRunsOnTheState(t *testing.T) {
	dir := t.TempDir()
	state := filepath.Join(dir, "data", "SIPGES")
	put(t, filepath.Join(state, "pg18", "PG_VERSION"), "18\n", 0)
	frozenPostgres(t, state)
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
	frozenPostgres(t, f.state)
	_, err := f.update(f.release("1.1.0"), noop, noop)
	_ = wantCode(t, err, CodeRefused, "update over a running cluster")
	if exists(t, filepath.Join(f.root, journalName)) {
		t.Fatal("a journal was written")
	}
}

// A pid file left by a crashed server does not block the update, whether its process id is free
// or now belongs to another program (common after a restart).
func TestAPidFileOfACrashedServerDoesNotBlockTheUpdate(t *testing.T) {
	for _, name := range []string{"dead", "reused"} {
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			f := newFixture(t, dir)
			dataDir := filepath.Join(f.state, "pg18")
			put(t, filepath.Join(dataDir, "PG_VERSION"), "18\n", 0)
			pid := 2147483646
			if name == "reused" {
				pid = sleeper(t, "", t.TempDir())
			}
			put(t, filepath.Join(dataDir, "postmaster.pid"), pidFile(pid, dataDir, closedPort(t)), 0)
			if _, err := f.update(f.release("1.1.0"), noop, noop); err != nil {
				t.Fatalf("update with a stale postmaster.pid: %v", err)
			}
		})
	}
}
