package main

// The correction batch of PR #535: orphan PostgreSQL servers, the launcher lock, a half-written
// request, a server that does not stop, and --install=<root>.

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/desktopupdate"
)

// pendingJournal writes an update journal as a crash between the state copy and the migration
// leaves it, with its pre-update copy.
func pendingJournal(t *testing.T, f *fixture) string {
	t.Helper()
	mkdir(t, f.state)
	pre := f.state + ".pre-update-20261118T000000Z-1.1.0"
	mkdir(t, pre)
	put(t, filepath.Join(f.root, "update-journal.json"), `{"from":{"version":"1.0.0","path":"versions/1.0.0","adopted":false},`+
		`"to":{"version":"1.1.0","path":"versions/1.1.0"},"stateDir":`+jsonField("x", f.state)[4:]+`,"preCopy":`+jsonField("x", pre)[4:]+
		`,"failedAside":"","restoring":"","phase":"state-copied"}`)
	return pre
}

type orphanCalls struct {
	mu    sync.Mutex
	calls [][]string
	// journalAtCall records whether the journal still existed at each call.
	journalAtCall []bool
}

func (o *orphanCalls) stopper(root string, fail error) func(context.Context, []string) error {
	return func(_ context.Context, folders []string) error {
		_, err := os.Stat(filepath.Join(root, "update-journal.json"))
		o.mu.Lock()
		o.calls = append(o.calls, folders)
		o.journalAtCall = append(o.journalAtCall, err == nil)
		o.mu.Unlock()
		return fail
	}
}

// B1: before Recover, the servers a dead launcher left on the state folder and on every copy the
// journal names are stopped.
func TestOrphanServersAreStoppedBeforeRecovery(t *testing.T) {
	f := newFixture(t)
	pre := pendingJournal(t, f)
	calls := &orphanCalls{}
	r := startLauncher(t, f, func(c *launchConfig) { c.Source = ""; c.StopOrphans = calls.stopper(f.root, nil) })
	r.waitEvent("started", 1)
	calls.mu.Lock()
	defer calls.mu.Unlock()
	if len(calls.calls) == 0 || !calls.journalAtCall[0] {
		t.Fatalf("not called before recovery: %v %v", calls.calls, calls.journalAtCall)
	}
	if first := calls.calls[0]; !slices.Contains(first, f.state) || !slices.Contains(first, pre) {
		t.Fatalf("folders %v", first)
	}
}

// B1: a server that cannot be stopped halts with exit 3 and the Spanish notice; nothing is renamed.
func TestAnOrphanServerThatCannotBeStoppedHaltsWithoutRenaming(t *testing.T) {
	f := newFixture(t)
	pendingJournal(t, f)
	calls := &orphanCalls{}
	r := startLauncher(t, f, func(c *launchConfig) {
		c.StopOrphans = calls.stopper(f.root, errors.New("pg_ctl stop: synthetic failure"))
	})
	res, ok := r.result(5 * time.Second)
	if !ok || res.err == nil {
		t.Fatalf("result %+v %v", res, ok)
	}
	var stderr bytes.Buffer
	if code := reportStartError(res.err, &stderr); code != 3 {
		t.Fatalf("exit %d", code)
	}
	if !strings.HasPrefix(stderr.String(), "SIPGES no se inició: un PostgreSQL de un inicio anterior sigue en ejecución") {
		t.Fatalf("stderr %q", stderr.String())
	}
	if refused := r.waitEvent("start_refused", 1); !strings.Contains(refused["reason"].(string), "synthetic failure") {
		t.Fatalf("start_refused %v", refused)
	}
	if _, err := os.Stat(filepath.Join(f.root, "update-journal.json")); err != nil {
		t.Fatalf("the journal was consumed: %v", err)
	}
	if siblings, _ := os.ReadDir(f.dir); slices.ContainsFunc(siblings, func(e os.DirEntry) bool { return strings.Contains(e.Name(), ".failed-") }) {
		t.Fatal("the state folder was set aside")
	}
	if len(r.serve.versions()) != 0 {
		t.Fatal("a version started")
	}
}

// B1: the orphans are looked for again right before an update.
func TestOrphanServersAreStoppedBeforeAnUpdate(t *testing.T) {
	f := newFixture(t)
	f.release("1.1.0", releaseOptions{})
	calls := &orphanCalls{}
	r := startLauncher(t, f, func(c *launchConfig) { c.StopOrphans = calls.stopper(f.root, nil) })
	r.waitEvent("update_check", 1)
	f.request("1.1.0")
	r.waitEvent("updated", 1)
	calls.mu.Lock()
	defer calls.mu.Unlock()
	if len(calls.calls) != 2 {
		t.Fatalf("calls %v", calls.calls)
	}
}

// A1: a second launcher on the same install is refused before it touches the update channel.
func TestASecondLauncherChangesNothing(t *testing.T) {
	f := newFixture(t)
	f.release("1.1.0", releaseOptions{})
	r := startLauncher(t, f, nil)
	r.waitEvent("update_check", 1)
	status, err := os.ReadFile(filepath.Join(f.root, "update-channel", "status.json"))
	if err != nil {
		t.Fatal(err)
	}
	var stdout, stderr bytes.Buffer
	code := runLauncherCLI(context.Background(), []string{"--install", f.root, "--port", "18004"}, nil, &stdout, &stderr, nil)
	if code != 1 || !strings.Contains(stderr.String(), "SIPGES ya está en ejecución") {
		t.Fatalf("exit %d %q", code, stderr.String())
	}
	again, _ := os.ReadFile(filepath.Join(f.root, "update-channel", "status.json"))
	if !bytes.Equal(status, again) {
		t.Fatalf("status.json changed:\n%s\n%s", status, again)
	}
	f.request("1.1.0")
	if updated := r.waitEvent("updated", 1); updated["to"] != "1.1.0" {
		t.Fatalf("the first launcher no longer updates: %v", updated)
	}
}

// review: a half-written or unparsable request.json is ignored and kept, never deleted; once it
// is complete it applies.
func TestAHalfWrittenRequestIsKeptUntilComplete(t *testing.T) {
	f := newFixture(t)
	f.release("1.1.0", releaseOptions{})
	r := startLauncher(t, f, nil)
	r.waitEvent("update_check", 1)
	path := filepath.Join(f.root, "update-channel", "request.json")
	put(t, path, `{"format":1,"vers`)
	r.waitEvent("update_request_ignored", 1)
	time.Sleep(150 * time.Millisecond)
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("the half-written request was deleted: %v", err)
	}
	ignored := 0
	for _, name := range r.names() {
		if name == "update_request_ignored" {
			ignored++
		}
	}
	if ignored != 1 {
		t.Fatalf("logged %d times: %v", ignored, r.names())
	}
	f.request("1.1.0")
	if updated := r.waitEvent("updated", 1); updated["to"] != "1.1.0" {
		t.Fatalf("updated %v", updated)
	}
}

// review: when the server does not stop, no update runs; stop_failed is logged and SIPGES keeps serving.
func TestAServerThatDoesNotStopIsNeverUpdated(t *testing.T) {
	f := newFixture(t)
	f.release("1.1.0", releaseOptions{})
	updates := 0
	r := startLauncher(t, f, func(c *launchConfig) {
		c.Migrate = func(context.Context, desktopupdate.Target) error { updates++; return nil }
	})
	r.waitEvent("started", 1)
	r.serve.mu.Lock()
	srv := r.serve.running
	r.serve.mu.Unlock()
	srv.mu.Lock()
	srv.failStop = errors.New("synthetic stop failure")
	srv.mu.Unlock()
	r.waitEvent("update_check", 1)
	f.request("1.1.0")
	if failed := r.waitEvent("stop_failed", 1); failed["reason"] != "synthetic stop failure" {
		t.Fatalf("stop_failed %v", failed)
	}
	time.Sleep(100 * time.Millisecond)
	if updates != 0 || f.current() != "1.0.0" || slices.Contains(r.names(), "updated") || slices.Contains(r.names(), "update_failed") {
		t.Fatalf("updated anyway: %v", r.names())
	}
	select {
	case <-srv.Exited():
		t.Fatal("the server was ended")
	default:
	}
	if res, ended := r.result(50 * time.Millisecond); ended {
		t.Fatalf("the launcher ended: %+v", res)
	}
}

// review: --install=<root> is accepted as well as --install <root>.
func TestTheLauncherAcceptsTheEqualsForm(t *testing.T) {
	o, err := parseLauncherArgs([]string{"--install=/r", "--releases=/x", "--port=9001", "--pg-bin=/pg"}, lookupOf(nil))
	if err != nil || o.install != "/r" || o.releases != "/x" || o.port != 9001 || o.pgBin != "/pg" {
		t.Fatalf("%+v %v", o, err)
	}
	if _, err := parseLauncherArgs([]string{"--install=/r", "--install", "/s"}, lookupOf(nil)); err == nil {
		t.Fatal("a repeated --install was accepted")
	}
	if _, err := parseLauncherArgs([]string{"--install="}, lookupOf(nil)); err == nil {
		t.Fatal("an empty --install= was accepted")
	}
}
