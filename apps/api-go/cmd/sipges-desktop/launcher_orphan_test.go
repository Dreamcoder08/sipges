//go:build !windows

package main

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/localpg/pgbin"
)

func processAlive(pid int) bool { return pid > 0 && syscall.Kill(pid, 0) == nil }

// The verifier's probe (B1): the launcher is killed (SIGKILL) while the first start migrates the
// real state folder, which leaves its PostgreSQL running. The next start must stop that server
// before recovery sets the folder aside, then start normally.
func TestALauncherKilledDuringTheFirstStartLeavesNoPostgresBehind(t *testing.T) {
	bin := pgbin.ForTest(t)
	f := goFixture(t)
	put(t, filepath.Join(f.state, "data-key"), "c3ludGhldGljLWRhdGEta2V5LTMyLWJ5dGVzLXh4eHg=\n")
	put(t, filepath.Join(f.state, "admin-password"), "SyntheticAdmin-2026\n")
	env := []string{"PATH=" + os.Getenv("PATH")}
	if code := runLauncherCLI(context.Background(), []string{"--install", f.root, "--prepare-only", "--pg-bin", bin}, env, os.Stderr, os.Stderr, nil); code != 0 {
		t.Fatalf("--prepare-only: exit %d", code)
	}
	// What a committed move (pglite-to-postgres.mjs --prepared) does last.
	if err := os.Remove(filepath.Join(f.state, pendingMoveName)); err != nil {
		t.Fatal(err)
	}

	port := freePort(t)
	args := strings.Join([]string{"--install", f.root, "--port", strconv.Itoa(port), "--pg-bin", bin}, "\x1f")
	out, err := os.Create(filepath.Join(t.TempDir(), "launcher.log"))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = out.Close() }()
	launcher := exec.Command(os.Args[0], "-test.run=^$")
	launcher.Env = append(slices.Clone(env), launcherEnvHelper+"="+args)
	launcher.Stdout, launcher.Stderr = out, out
	if err := launcher.Start(); err != nil {
		t.Fatal(err)
	}
	pidFile := filepath.Join(f.state, "pg18", "postmaster.pid")
	journal := filepath.Join(f.root, "update-journal.json")
	orphan := 0
	deadline := time.Now().Add(3 * time.Minute)
	for orphan == 0 && time.Now().Before(deadline) {
		if _, err := os.Stat(journal); err == nil {
			if body, err := os.ReadFile(pidFile); err == nil {
				if pid, err := strconv.Atoi(lineOf(string(body), 0)); err == nil && pid > 0 {
					orphan = pid
					break
				}
			}
		}
		time.Sleep(2 * time.Millisecond)
	}
	_ = launcher.Process.Kill()
	_ = launcher.Wait()
	if orphan == 0 {
		log, _ := os.ReadFile(out.Name())
		t.Fatalf("never saw the first start migrate the state folder\n%s", log)
	}
	t.Cleanup(func() {
		if processAlive(orphan) {
			_ = syscall.Kill(orphan, syscall.SIGQUIT)
		}
	})
	time.Sleep(200 * time.Millisecond)
	if !processAlive(orphan) {
		t.Skip("PostgreSQL ended with the launcher here: the probe left no orphan")
	}

	ctx, stop := context.WithCancel(context.Background())
	defer stop()
	logs := &lockedBuffer{}
	done := make(chan int, 1)
	go func() {
		done <- runLauncherCLI(ctx, []string{"--install", f.root, "--port", strconv.Itoa(port), "--pg-bin", bin}, env, logs, logs, nil)
	}()
	waitHealthCode(t, port, done)
	if processAlive(orphan) {
		t.Fatalf("the PostgreSQL of the killed launcher (pid %d) is still running", orphan)
	}
	stop()
	select {
	case code := <-done:
		if code != 0 {
			t.Fatalf("exit %d\n%s", code, logs.String())
		}
	case <-time.After(2 * time.Minute):
		t.Fatal("the launcher did not stop")
	}
}
