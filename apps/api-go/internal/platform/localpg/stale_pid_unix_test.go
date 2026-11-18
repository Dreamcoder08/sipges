//go:build !windows

package localpg

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

// otherProgram starts a long-lived process that is not PostgreSQL, as the program the operating
// system may give a dead server's process id to after a restart.
// It returns the process id and a channel closed when the program ends.
func otherProgram(t *testing.T, dir string) (int, <-chan struct{}) {
	t.Helper()
	cmd := exec.Command("sleep", "300")
	cmd.Dir = dir
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	ended := make(chan struct{})
	go func() { _ = cmd.Wait(); close(ended) }()
	t.Cleanup(func() { _ = cmd.Process.Kill(); <-ended })
	return cmd.Process.Pid, ended
}

func endedOf(ended <-chan struct{}) bool {
	select {
	case <-ended:
		return true
	case <-time.After(100 * time.Millisecond):
		return false
	}
}

// withPid rewrites the first line (the process id) of a postmaster.pid body.
func withPid(body string, pid int) string {
	_, rest, _ := strings.Cut(body, "\n")
	return strconv.Itoa(pid) + "\n" + rest
}

// A server that died left postmaster.pid, and its process id now belongs to another program,
// even one working in the data folder: Start must neither signal that program nor refuse.
func TestStartIgnoresAPidFileWhoseProcessIsAnotherProgram(t *testing.T) {
	for _, where := range []string{"elsewhere", "in the data folder"} {
		t.Run(where, func(t *testing.T) {
			opts := options(t)
			s := startT(t, opts)
			pidFile := filepath.Join(opts.DataDir, "postmaster.pid")
			body, err := os.ReadFile(pidFile)
			if err != nil {
				t.Fatal(err)
			}
			if err := s.Stop(context.Background()); err != nil {
				t.Fatal(err)
			}
			dir := t.TempDir()
			if where != "elsewhere" {
				dir = opts.DataDir
			}
			other, ended := otherProgram(t, dir)
			writeFile(t, pidFile, withPid(string(body), other))
			if _, serving := Serving(context.Background(), opts.DataDir); serving {
				t.Fatal("Serving: a program that is not PostgreSQL counts as the server")
			}
			ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
			defer cancel()
			next, err := Start(ctx, opts)
			if where != "elsewhere" {
				// Only PostgreSQL's own lock check can refuse here; the program is never signalled.
				if err == nil {
					_ = next.Stop(context.Background())
				}
			} else {
				if err != nil {
					log, _ := os.ReadFile(opts.LogPath)
					t.Fatalf("Start over a reused pid: %v\n%s", err, log)
				}
				t.Cleanup(func() { _ = next.Stop(context.Background()) })
			}
			if endedOf(ended) {
				t.Fatalf("the other program (pid %d) was stopped", other)
			}
		})
	}
}

// N1: a server left running is stopped with pg_ctl stop on its folder (then killed when that
// fails), never by starting PostgreSQL on the folder.
func TestStopLeftoverStopsWithoutStartingAServer(t *testing.T) {
	opts := options(t)
	orphan := startT(t, opts)
	crash(orphan)
	pid := postmasterPID(t, opts.DataDir)
	if _, serving := Serving(context.Background(), opts.DataDir); !serving {
		t.Fatal("Serving: the running server does not count")
	}
	leftover := Options{BinDir: opts.BinDir, DataDir: opts.DataDir, LogPath: filepath.Join(t.TempDir(), "leftover.log")}
	stopped, err := StopLeftover(context.Background(), leftover)
	if err != nil || !stopped {
		t.Fatalf("StopLeftover = %v, %v", stopped, err)
	}
	waitGone(t, pid)
	if log, _ := os.ReadFile(leftover.LogPath); strings.Contains(string(log), "ready to accept connections") {
		t.Fatalf("a server was started on the folder:\n%s", log)
	}
	if stopped, err := StopLeftover(context.Background(), leftover); err != nil || stopped {
		t.Fatalf("StopLeftover with nothing running = %v, %v", stopped, err)
	}
}
