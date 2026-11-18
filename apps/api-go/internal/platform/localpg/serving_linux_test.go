//go:build linux

package localpg

import (
	"context"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

// PR #540 verifier blocker: a real PostgreSQL on the folder must count as serving even when its
// port does not answer the probe. On Linux the postmaster's working folder is the data folder,
// and that alone proves it, so an update never copies a live cluster.

// stopped initialises a cluster and stops it, leaving a data folder a test can serve its own way.
func stopped(t *testing.T) Options {
	t.Helper()
	opts := options(t)
	s := startT(t, opts)
	if err := s.Stop(context.Background()); err != nil {
		t.Fatal(err)
	}
	return opts
}

// serveWith runs pg_ctl start with the given server options and stops the server at cleanup.
func serveWith(t *testing.T, opts Options, serverOptions string) {
	t.Helper()
	pgctl := program(opts.BinDir, "pg_ctl")
	out, err := exec.Command(pgctl, "start", "-D", opts.DataDir, "-l", opts.LogPath, "-w", "-t", "60", "-o", serverOptions).CombinedOutput()
	if err != nil {
		log, _ := os.ReadFile(opts.LogPath)
		t.Fatalf("pg_ctl start %s: %v\n%s\n%s", serverOptions, err, out, log)
	}
	t.Cleanup(func() {
		_ = exec.Command(pgctl, "stop", "-D", opts.DataDir, "-m", "immediate", "-w").Run()
	})
}

func closedLoopbackPort(t *testing.T) int {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	_ = ln.Close()
	return port
}

func wantServing(t *testing.T, dataDir string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if _, serving := Serving(ctx, dataDir); !serving {
		t.Fatal("Serving: a live PostgreSQL on the folder does not count")
	}
}

// A postmaster frozen (SIGSTOP, or an antivirus holding it) accepts the connection in the kernel
// and never answers the probe.
func TestServingCountsAFrozenPostmaster(t *testing.T) {
	opts := options(t)
	s := startT(t, opts)
	crash(s)
	pid := postmasterPID(t, opts.DataDir)
	if err := syscall.Kill(pid, syscall.SIGSTOP); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = syscall.Kill(pid, syscall.SIGCONT) })
	wantServing(t, opts.DataDir)
}

// The port postmaster.pid names does not reach the server.
func TestServingCountsAServerWhosePidFilePortIsUnreachable(t *testing.T) {
	opts := options(t)
	startT(t, opts)
	pidFile := filepath.Join(opts.DataDir, "postmaster.pid")
	body, err := os.ReadFile(pidFile)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.WriteFile(pidFile, body, 0o600) })
	lines := strings.Split(string(body), "\n")
	lines[3] = strconv.Itoa(closedLoopbackPort(t))
	writeFile(t, pidFile, strings.Join(lines, "\n"))
	wantServing(t, opts.DataDir)
}

// A server that listens only on a Unix socket.
func TestServingCountsASocketOnlyServer(t *testing.T) {
	opts := stopped(t)
	sockets, err := os.MkdirTemp("/tmp", "sipges-sock")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(sockets) })
	serveWith(t, opts, "-p "+strconv.Itoa(closedLoopbackPort(t))+" -c listen_addresses= -c unix_socket_directories="+sockets)
	wantServing(t, opts.DataDir)
}

// A server that listens only on ::1.
func TestServingCountsAnIPv6OnlyServer(t *testing.T) {
	ln, err := net.Listen("tcp", "[::1]:0")
	if err != nil {
		t.Skipf("no IPv6 loopback: %v", err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	_ = ln.Close()
	opts := stopped(t)
	serveWith(t, opts, "-p "+strconv.Itoa(port)+" -c listen_addresses=::1 -c unix_socket_directories=")
	wantServing(t, opts.DataDir)
}

// A server starting up: postmaster.pid is written and the postmaster is paused before it serves.
func TestServingCountsAServerThatIsStartingUp(t *testing.T) {
	opts := stopped(t)
	logFile, err := os.Create(opts.LogPath + ".startup")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = logFile.Close() })
	cmd := exec.Command(program(opts.BinDir, "postgres"), "-D", opts.DataDir,
		"-p", strconv.Itoa(closedLoopbackPort(t)), "-c", "listen_addresses=127.0.0.1", "-c", "unix_socket_directories=")
	cmd.Stdout, cmd.Stderr = logFile, logFile
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	pid := cmd.Process.Pid
	t.Cleanup(func() {
		_ = syscall.Kill(pid, syscall.SIGCONT)
		_ = syscall.Kill(pid, syscall.SIGQUIT)
		_ = cmd.Wait()
	})
	pidFile := filepath.Join(opts.DataDir, "postmaster.pid")
	for deadline := time.Now().Add(30 * time.Second); ; time.Sleep(time.Millisecond) {
		if _, err := os.Stat(pidFile); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("postmaster.pid never appeared")
		}
	}
	if err := syscall.Kill(pid, syscall.SIGSTOP); err != nil {
		t.Fatal(err)
	}
	wantServing(t, opts.DataDir)
}

// The leftover step (sipges-desktop before it renames a state folder) stops a frozen postmaster
// rather than leaving it under the folder: pg_ctl stop gives up, then the kill ends it.
func TestStopLeftoverEndsAFrozenPostmaster(t *testing.T) {
	opts := options(t)
	s := startT(t, opts)
	crash(s)
	pid := postmasterPID(t, opts.DataDir)
	if err := syscall.Kill(pid, syscall.SIGSTOP); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = syscall.Kill(pid, syscall.SIGCONT) })
	leftover := Options{BinDir: opts.BinDir, DataDir: opts.DataDir, LogPath: filepath.Join(t.TempDir(), "leftover.log"), StopTimeout: 2 * time.Second}
	stopped, err := StopLeftover(context.Background(), leftover)
	if !stopped && err == nil {
		t.Fatal("StopLeftover left a frozen postmaster running and reported nothing")
	}
	waitGone(t, pid)
}
