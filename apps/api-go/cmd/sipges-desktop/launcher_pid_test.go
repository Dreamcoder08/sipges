//go:build !windows

package main

// T72d3 follow-up of PR #535: a stale or reused postmaster.pid never locks the person out, a
// leftover server is stopped without starting PostgreSQL on its folder, and the review's
// untested paths.

import (
	"bytes"
	"context"
	"errors"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/desktopupdate"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/localpg"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/localpg/pgbin"
)

// otherProgram starts a long-lived process that is not PostgreSQL.
// It returns the process id and a channel closed when the program ends.
func otherProgram(t *testing.T) (int, <-chan struct{}) {
	t.Helper()
	cmd := exec.Command("sleep", "300")
	cmd.Dir = t.TempDir()
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	ended := make(chan struct{})
	go func() { _ = cmd.Wait(); close(ended) }()
	t.Cleanup(func() { _ = cmd.Process.Kill(); <-ended })
	return cmd.Process.Pid, ended
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

// Finding 1: after a restart, postmaster.pid names a process id the operating system gave to
// another program. The leftover-PostgreSQL step treats the folder as free: SIPGES starts, never
// halts with exit 3, and the other program is left alone.
func TestAReusedPidNeverHaltsTheStart(t *testing.T) {
	bin := pgbin.ForTest(t)
	f := newFixture(t)
	other, ended := otherProgram(t)
	dataDir := filepath.Join(f.state, dataFolder)
	put(t, filepath.Join(f.state, "data-key"), "c3ludGhldGljLWRhdGEta2V5LTMyLWJ5dGVzLXh4eHg=\n")
	put(t, filepath.Join(f.state, "admin-password"), "SyntheticAdmin-2026\n")
	put(t, filepath.Join(dataDir, "PG_VERSION"), "18\n")
	put(t, filepath.Join(dataDir, "postmaster.pid"), strconv.Itoa(other)+"\n"+dataDir+"\n1700000000\n"+
		strconv.Itoa(closedPort(t))+"\n/tmp\n127.0.0.1\n  0  0\nready   \n")
	logs := &lockedBuffer{}
	stop := stopOrphanClusters(runtimeEnv{pgBin: bin, stdout: logs, stderr: logs}, f.root)
	if err := stop(context.Background(), []string{f.state}); err != nil {
		t.Fatalf("the leftover step refused a reused pid: %v", err)
	}
	r := startLauncher(t, f, func(c *launchConfig) { c.Source = ""; c.StopOrphans = stop })
	if res, ended := r.result(3 * time.Second); ended {
		t.Fatalf("ended %+v: %v", res, r.events())
	}
	r.waitEvent("started", 1)
	if slices.Contains(r.names(), "start_refused") {
		t.Fatalf("refused: %v", r.events())
	}
	select {
	case <-ended:
		t.Fatal("the other program was stopped")
	case <-time.After(100 * time.Millisecond):
	}
	if strings.Contains(logs.String(), "stopped the PostgreSQL left running") {
		t.Fatalf("reported a stop: %s", logs.String())
	}
}

// Finding 2 (N1): a server left running on a copy is stopped with pg_ctl stop on that folder,
// never by starting PostgreSQL on it.
func TestALeftoverServerOnACopyIsStoppedWithoutStartingOne(t *testing.T) {
	bin := pgbin.ForTest(t)
	f := newFixture(t)
	copyDir := filepath.Join(t.TempDir(), "SIPGES.pre-update-20261118T000000Z-1.1.0")
	dataDir := filepath.Join(copyDir, dataFolder)
	ctx := context.Background()
	pg, err := localpg.Start(ctx, localpg.Options{BinDir: bin, DataDir: dataDir, LogPath: filepath.Join(t.TempDir(), "init.log"), SuperPassword: "synthetic-super"})
	if err != nil {
		t.Fatal(err)
	}
	if err := pg.Stop(ctx); err != nil {
		t.Fatal(err)
	}
	// Its secrets are there, so nothing but the rule keeps a start away from the copy.
	put(t, filepath.Join(copyDir, "pg18-superuser-password"), "synthetic-super\n")
	// The killed launcher's server, started outside localpg's lock.
	orphanLog := filepath.Join(t.TempDir(), "orphan.log")
	if out, err := exec.Command(filepath.Join(bin, "pg_ctl"), "start", "-w", "-D", dataDir, "-l", orphanLog,
		"-o", "-p "+strconv.Itoa(closedPort(t))+" -c listen_addresses=127.0.0.1 -c unix_socket_directories=").CombinedOutput(); err != nil {
		t.Fatalf("pg_ctl start: %v\n%s", err, out)
	}
	t.Cleanup(func() {
		_ = exec.Command(filepath.Join(bin, "pg_ctl"), "stop", "-D", dataDir, "-m", "immediate").Run()
	})
	logs := &lockedBuffer{}
	if err := stopOrphanClusters(runtimeEnv{pgBin: bin, stdout: logs, stderr: logs}, f.root)(ctx, []string{copyDir}); err != nil {
		t.Fatalf("stop the leftover: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dataDir, "postmaster.pid")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("PostgreSQL still runs on the copy: %v", err)
	}
	if log, _ := os.ReadFile(filepath.Join(copyDir, dataFolder+".log")); strings.Contains(string(log), "ready to accept connections") {
		t.Fatalf("a server was started on the copy:\n%s", log)
	}
	if !strings.Contains(logs.String(), "stopped the PostgreSQL left running on "+dataDir) {
		t.Fatalf("no stop reported: %s", logs.String())
	}
}

// Finding 3: a leftover PostgreSQL that cannot be stopped just before an update: no update,
// stop_failed is logged, SIPGES keeps serving.
func TestALeftoverThatCannotBeStoppedBeforeAnUpdateKeepsServing(t *testing.T) {
	f := newFixture(t)
	f.release("1.1.0", releaseOptions{})
	var mu sync.Mutex
	calls := 0
	updates := 0
	r := startLauncher(t, f, func(c *launchConfig) {
		c.StopOrphans = func(context.Context, []string) error {
			mu.Lock()
			defer mu.Unlock()
			calls++
			if calls > 1 {
				return errors.New("synthetic leftover stop failure")
			}
			return nil
		}
		c.Migrate = func(context.Context, desktopupdate.Target) error { updates++; return nil }
	})
	r.waitEvent("update_check", 1)
	f.request("1.1.0")
	if failed := r.waitEvent("stop_failed", 1); failed["reason"] != "synthetic leftover stop failure" {
		t.Fatalf("stop_failed %v", failed)
	}
	r.waitEvent("started", 2)
	time.Sleep(100 * time.Millisecond)
	if updates != 0 || f.current() != "1.0.0" || slices.Contains(r.names(), "updated") || slices.Contains(r.names(), "update_failed") {
		t.Fatalf("updated anyway: %v", r.names())
	}
	if versions := r.serve.versions(); len(versions) != 2 || versions[1] != "1.0.0" {
		t.Fatalf("not serving the installed version again: %v", versions)
	}
	if res, ended := r.result(50 * time.Millisecond); ended {
		t.Fatalf("the launcher ended: %+v", res)
	}
}

// Finding 3: --install=<root> goes through main's switch into the launcher, not the plain desktop.
func TestMainRoutesTheEqualsFormToTheLauncher(t *testing.T) {
	f := newFixture(t)
	cmd := exec.Command(os.Args[0], "-test.run=^$")
	cmd.Env = []string{"PATH=" + os.Getenv("PATH"), mainEnvHelper + "=" + strings.Join([]string{"--install=" + f.root, "--port=" + strconv.Itoa(closedPort(t))}, "\x1f")}
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	err := cmd.Run()
	var exit *exec.ExitError
	if !errors.As(err, &exit) || exit.ExitCode() != 1 {
		t.Fatalf("exit %v\n%s\n%s", err, stdout.String(), stderr.String())
	}
	// Only the launcher looks for PostgreSQL in the installed version's folder; the plain desktop
	// would have asked for its state folder instead.
	if !strings.Contains(stderr.String(), "no postgresql/bin in "+filepath.Join(f.root, "versions")) ||
		strings.Contains(stderr.String(), "No se encontró la carpeta de datos") {
		t.Fatalf("not the launcher:\n%s\n%s", stdout.String(), stderr.String())
	}
}

// Finding 4: a request.json that is valid JSON but not an object is dropped with a log line, not
// kept forever; a later request still applies.
func TestARequestThatIsNotAnObjectIsDropped(t *testing.T) {
	f := newFixture(t)
	f.release("1.1.0", releaseOptions{})
	r := startLauncher(t, f, nil)
	r.waitEvent("update_check", 1)
	path := filepath.Join(f.root, "update-channel", "request.json")
	for i, body := range []string{`["1.1.0"]`, `null`, `"1.1.0"`} {
		put(t, path, body)
		r.waitEvent("update_request_ignored", i+1)
		deadline := time.Now().Add(5 * time.Second)
		for {
			if _, err := os.Stat(path); errors.Is(err, os.ErrNotExist) {
				break
			}
			if time.Now().After(deadline) {
				t.Fatalf("%s was kept", body)
			}
			time.Sleep(10 * time.Millisecond)
		}
	}
	f.request("1.1.0")
	if updated := r.waitEvent("updated", 1); updated["to"] != "1.1.0" {
		t.Fatalf("updated %v", updated)
	}
}
