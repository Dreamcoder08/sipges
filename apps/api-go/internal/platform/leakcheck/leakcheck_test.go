package leakcheck

import (
	"bytes"
	"strings"
	"testing"
	"time"
)

// leakOne starts a goroutine blocked on a channel that nothing else can reach once this
// function returns: the runtime can prove it never wakes up.
func leakOne(release *chan struct{}) {
	ch := make(chan struct{})
	go func() { <-ch }()
	if release != nil {
		*release = ch
	}
}

// waitBlocked gives a just-started goroutine time to park on its channel.
func waitBlocked() { time.Sleep(20 * time.Millisecond) }

func TestReportFindsUnreachableBlockedGoroutine(t *testing.T) {
	before, _ := report()
	leakOne(nil)
	waitBlocked()

	count, stacks := report()
	if count != before+1 {
		t.Fatalf("leak count = %d, want %d", count, before+1)
	}
	if !strings.Contains(stacks, "leakOne") {
		t.Fatalf("report does not name the leaking function:\n%s", stacks)
	}
}

func TestReportIgnoresBlockedGoroutineStillReachable(t *testing.T) {
	before, _ := report()
	keep := make(chan struct{})
	done := make(chan struct{})
	go func() { <-keep; close(done) }()
	waitBlocked()

	if count, stacks := report(); count != before {
		t.Fatalf("reachable goroutine reported as a leak (%d, want %d):\n%s", count, before, stacks)
	}
	close(keep)
	<-done
}

func TestAfterKeepsFailingExitCodeWithoutChecking(t *testing.T) {
	var out bytes.Buffer
	if got := after(3, &out, func() (int, string) { t.Fatal("checked leaks after failing tests"); return 0, "" }); got != 3 {
		t.Fatalf("after(3) = %d, want 3", got)
	}
	if out.Len() != 0 {
		t.Fatalf("unexpected output: %q", out.String())
	}
}

func TestAfterPassesWhenNothingLeaked(t *testing.T) {
	var out bytes.Buffer
	if got := after(0, &out, func() (int, string) { return 0, "goroutineleak profile: total 0\n" }); got != 0 {
		t.Fatalf("after(0) with no leaks = %d, want 0", got)
	}
	if out.Len() != 0 {
		t.Fatalf("unexpected output: %q", out.String())
	}
}

func TestAfterFailsAndPrintsStacksOnLeak(t *testing.T) {
	var out bytes.Buffer
	stacks := "goroutineleak profile: total 2\n#\tpkg.worker+0x1\n"
	if got := after(0, &out, func() (int, string) { return 2, stacks }); got != 1 {
		t.Fatalf("after(0) with leaks = %d, want 1", got)
	}
	want := "leakcheck: 2 leaked goroutine(s) after the tests passed\n" + stacks
	if out.String() != want {
		t.Fatalf("output = %q, want %q", out.String(), want)
	}
}
