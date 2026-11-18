package desktopupdate

// Port of deploy/desktop/updater/verifier-lock.test.mjs and the lock cases of updater.test.mjs.

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func lockFiles(t *testing.T, root string) []string {
	t.Helper()
	out := []string{}
	for _, name := range names(t, root) {
		if strings.HasPrefix(name, "update.lock") {
			out = append(out, name)
		}
	}
	return out
}

func v2(pid int, heartbeat string) string {
	return fmt.Sprintf(`{"format":2,"pid":%d,"token":"synthetic-token","heartbeat":%q}`, pid, heartbeat)
}

// deadPid is the id of a process that already ended.
func deadPid(t *testing.T) int {
	t.Helper()
	cmd := exec.Command(os.Args[0], "-test.run=^$")
	if err := cmd.Run(); err != nil {
		t.Fatal(err)
	}
	return cmd.Process.Pid
}

func TestLockLeftBehindIsTakenOverAndALiveBeatingOneIsBusyAndByteIdentical(t *testing.T) {
	f := newFixture(t, t.TempDir())
	lock := filepath.Join(f.root, "update.lock")
	ctx := context.Background()
	taken := func(text, label string) {
		t.Helper()
		put(t, lock, text, 0)
		got, err := Recover(ctx, f.root)
		if err != nil || got.Current.Version != "1.0.0" {
			t.Fatalf("%s: %v %+v", label, err, got)
		}
		if l := lockFiles(t, f.root); len(l) != 0 {
			t.Fatalf("%s: left %v", label, l)
		}
	}
	taken(v2(os.Getppid(), isoAgo(180*time.Second)), "live foreign pid, heartbeat 3 min old")
	taken(v2(deadPid(t), isoAgo(time.Second)), "dead pid, fresh heartbeat")
	taken(fmt.Sprintf(`{"pid":%d,"time":%q}`, os.Getppid(), isoAgo(180*time.Second)), "old format, 3 min old")
	put(t, lock, "", 0)
	old := time.Now().Add(-180 * time.Second)
	if err := os.Chtimes(lock, old, old); err != nil {
		t.Fatal(err)
	}
	taken2, err := Recover(ctx, f.root)
	if err != nil || taken2.Current.Version != "1.0.0" || len(lockFiles(t, f.root)) != 0 {
		t.Fatalf("empty lock, old file time: %v", err)
	}

	busy := func(text, label string) {
		t.Helper()
		put(t, lock, text, 0)
		_, err := Recover(ctx, f.root)
		_ = wantCode(t, err, CodeBusy, label)
		if readText(t, lock) != text {
			t.Fatalf("%s: lock changed", label)
		}
		if l := lockFiles(t, f.root); len(l) != 1 || l[0] != "update.lock" {
			t.Fatalf("%s: %v", label, l)
		}
		if err := os.Remove(lock); err != nil {
			t.Fatal(err)
		}
	}
	busy(v2(os.Getppid(), isoAgo(time.Second)), "live pid, fresh heartbeat")
	busy(v2(os.Getppid(), isoAgo(110*time.Second)), "live pid, heartbeat 110 s old")
	busy("", "empty lock just created")
	busy(`{"pid":`, "half-written lock just created")
}

func TestLockReusedPidWithHeartbeatFromTheFutureStaysBusy(t *testing.T) {
	f := newFixture(t, t.TempDir())
	put(t, filepath.Join(f.root, "update.lock"), v2(os.Getppid(), isoAgo(-24*time.Hour)), 0)
	_, err := Recover(context.Background(), f.root)
	_ = wantCode(t, err, CodeBusy, "future heartbeat")
}

func TestLockOfACrashedUpdateWithAForeignPidIsTakenOver(t *testing.T) {
	f := newFixture(t, t.TempDir())
	lock := filepath.Join(f.root, "update.lock")
	put(t, lock, fmt.Sprintf(`{"pid":%d,"time":"2026-01-01T00:00:00.000Z"}`, os.Getppid()), 0)
	if got, err := Recover(context.Background(), f.root); err != nil || got.Current.Version != "1.0.0" {
		t.Fatal(err)
	}
	if got := names(t, f.root); strings.Join(got, ",") != "current.json,install.json,update.log,versions" {
		t.Fatalf("root holds %v", got)
	}
}

func TestLockLiveUpdaterKeepsItAcrossHeartbeatsOthersAreBusyNothingIsLeft(t *testing.T) {
	defer func(d time.Duration) { lockHeartbeat = d }(lockHeartbeat)
	lockHeartbeat = 100 * time.Millisecond
	f := newFixture(t, t.TempDir())
	release := f.release("1.1.0")
	lock := filepath.Join(f.root, "update.lock")
	entered, gate := make(chan struct{}), make(chan struct{})
	done := make(chan error, 1)
	go func() {
		_, err := f.update(release, func(context.Context, Target) error {
			close(entered)
			<-gate
			return nil
		}, noop)
		done <- err
	}()
	<-entered
	var seen []lockBody
	for i := 0; i < 3; i++ {
		time.Sleep(250 * time.Millisecond)
		_, err := Recover(context.Background(), f.root)
		e := wantCode(t, err, CodeBusy, "while migrating")
		if !strings.Contains(e.Message, fmt.Sprint(os.Getpid())) {
			t.Fatalf("message names the pid: %s", e.Message)
		}
		var body lockBody
		if err := json.Unmarshal([]byte(readText(t, lock)), &body); err != nil {
			t.Fatal(err)
		}
		seen = append(seen, body)
	}
	close(gate)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	beats := map[string]bool{}
	for _, b := range seen {
		if b.Token != seen[0].Token || b.Pid != os.Getpid() || b.Format != 2 {
			t.Fatalf("lock changed hands: %+v", seen)
		}
		beats[b.Heartbeat] = true
	}
	if len(beats) != 3 {
		t.Fatalf("heartbeats %+v", seen)
	}
	if l := lockFiles(t, f.root); len(l) != 0 {
		t.Fatalf("left %v", l)
	}
}

func TestLockManyRacersForOneStaleLockNeverHoldItTogether(t *testing.T) {
	f := newFixture(t, t.TempDir())
	lock := filepath.Join(f.root, "update.lock")
	dead := deadPid(t)
	for round := 0; round < 6; round++ {
		age := 200 * time.Second
		if round%2 == 1 {
			age = time.Second
		}
		put(t, lock, v2(dead, isoAgo(age)), 0)
		type result struct {
			held        bool
			enter, exit time.Time
			mine        bool
			err         error
		}
		results := make([]result, 3)
		var wg sync.WaitGroup
		start := make(chan struct{})
		for i := range results {
			wg.Add(1)
			go func(i int) {
				defer wg.Done()
				<-start
				held, err := acquireLock(f.root)
				if err != nil {
					results[i].err = err
					return
				}
				results[i].held = true
				results[i].enter = time.Now()
				var body lockBody
				if data, err := os.ReadFile(lock); err == nil && json.Unmarshal(data, &body) == nil {
					results[i].mine = body.Token == held.token
				}
				time.Sleep(40 * time.Millisecond)
				results[i].exit = time.Now()
				held.release()
			}(i)
		}
		close(start)
		wg.Wait()
		var holders []result
		for _, r := range results {
			if r.held {
				if !r.mine {
					t.Fatal("a holder found someone else's lock")
				}
				holders = append(holders, r)
			} else if codeOf(r.err) != CodeBusy {
				t.Fatalf("round %d: %v", round, r.err)
			}
		}
		for i := range holders {
			for j := range holders {
				if i != j && holders[i].enter.Before(holders[j].exit) && holders[j].enter.Before(holders[i].exit) {
					t.Fatalf("round %d: two holders overlapped", round)
				}
			}
		}
		if l := lockFiles(t, f.root); len(l) != 0 {
			t.Fatalf("round %d left %v", round, l)
		}
	}
}
