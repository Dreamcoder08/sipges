//go:build !windows

package desktopupdate

import (
	"io"
	"net"
	"os/exec"
	"path/filepath"
	"strconv"
	"testing"
)

// fakePostgres stands for a PostgreSQL serving <state>/pg18: a process working in that folder,
// named in its postmaster.pid, and a loopback port answering the protocol's SSLRequest with 'N'.
func fakePostgres(t *testing.T, state string) {
	t.Helper()
	dataDir := filepath.Join(state, clusterDir)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ln.Close() })
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go func() {
				defer func() { _ = conn.Close() }()
				if _, err := io.ReadFull(conn, make([]byte, 8)); err == nil {
					_, _ = conn.Write([]byte{'N'})
				}
			}()
		}
	}()
	pid := otherProgram(t, dataDir)
	port := ln.Addr().(*net.TCPAddr).Port
	put(t, filepath.Join(dataDir, "postmaster.pid"), pidFile(pid, dataDir, port), 0)
}

// otherProgram starts a process that is not PostgreSQL, working in dir.
func otherProgram(t *testing.T, dir string) int {
	t.Helper()
	cmd := exec.Command("sleep", "300")
	cmd.Dir = dir
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = cmd.Process.Kill(); _ = cmd.Wait() })
	return cmd.Process.Pid
}

func pidFile(pid int, dataDir string, port int) string {
	return strconv.Itoa(pid) + "\n" + dataDir + "\n1700000000\n" + strconv.Itoa(port) + "\n/tmp\n127.0.0.1\n  0  0\nready   \n"
}

// T72d2 verifier blocker B1: a copy of a running PostgreSQL cluster can be torn, and that copy is
// what a restore puts back. FirstStart and Update refuse while PostgreSQL serves <state>/pg18,
// before any journal or copy is written.
func TestFirstStartRefusesWhilePostgreSQLRunsOnTheState(t *testing.T) {
	dir := t.TempDir()
	state := filepath.Join(dir, "data", "SIPGES")
	put(t, filepath.Join(state, "pg18", "PG_VERSION"), "18\n", 0)
	fakePostgres(t, state)
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
	fakePostgres(t, f.state)
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
				pid = otherProgram(t, t.TempDir())
			}
			ln, err := net.Listen("tcp", "127.0.0.1:0")
			if err != nil {
				t.Fatal(err)
			}
			closed := ln.Addr().(*net.TCPAddr).Port
			_ = ln.Close()
			put(t, filepath.Join(dataDir, "postmaster.pid"), pidFile(pid, dataDir, closed), 0)
			if _, err := f.update(f.release("1.1.0"), noop, noop); err != nil {
				t.Fatalf("update with a stale postmaster.pid: %v", err)
			}
		})
	}
}
