package application

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// fakeRuntimeStore records attempts as automation_cursors would.
type fakeRuntimeStore struct {
	mu       sync.Mutex
	tenants  []string
	started  []RuntimeSource
	finished []string
}

func (f *fakeRuntimeStore) DueTenants(context.Context, int) ([]string, error) { return f.tenants, nil }

func (f *fakeRuntimeStore) Start(_ context.Context, _, _ string, source RuntimeSource, _ time.Time) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.started = append(f.started, source)
	return nil
}

func (f *fakeRuntimeStore) Finish(_ context.Context, _, _, status string, _ *TickReport, errText string, _ time.Time) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.finished = append(f.finished, status+":"+errText)
	return nil
}

func (f *fakeRuntimeStore) sources() []RuntimeSource {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]RuntimeSource(nil), f.started...)
}

// gate makes each tick wait until the test releases it.
type gate struct {
	entered chan struct{}
	release chan struct{}
}

func newGate() *gate {
	return &gate{entered: make(chan struct{}, 16), release: make(chan struct{}, 16)}
}

func (g *gate) tick(context.Context, string) (TickReport, error) {
	g.entered <- struct{}{}
	<-g.release
	return TickReport{Tenants: 1, Scanned: 1}, nil
}

func syncSpawn(wg *sync.WaitGroup) func(func()) {
	return func(task func()) {
		wg.Add(1)
		go func() { defer wg.Done(); task() }()
	}
}

func TestWritesDuringATickAskForOneMoreScanAtMostTwice(t *testing.T) {
	store := &fakeRuntimeStore{}
	g := newGate()
	var wg sync.WaitGroup
	rt := &Runtime{Store: store, Tick: g.tick, Spawn: syncSpawn(&wg)}

	rt.Dispatch("T/P") // starts a tick
	<-g.entered
	rt.Dispatch("T/P") // two writes during it: one rescan
	rt.Dispatch("T/P")
	g.release <- struct{}{}
	<-g.entered // the rescan
	rt.Dispatch("T/P")
	g.release <- struct{}{}
	<-g.entered        // the second rescan
	rt.Dispatch("T/P") // a third is left to the cron
	g.release <- struct{}{}
	wg.Wait()

	if got := store.sources(); len(got) != 3 || got[0] != SourceEvent || got[1] != SourceEvent || got[2] != SourceEvent {
		t.Fatalf("attempts %v, want three event attempts", got)
	}
	rt.mu.Lock()
	defer rt.mu.Unlock()
	if len(rt.running) != 0 {
		t.Fatalf("running map not cleaned: %v", rt.running)
	}
}

func TestAWriteAfterTheTickEndsStartsAFreshOne(t *testing.T) {
	store := &fakeRuntimeStore{}
	var wg sync.WaitGroup
	ticks := atomic.Int32{}
	rt := &Runtime{Store: store, Spawn: syncSpawn(&wg), Tick: func(context.Context, string) (TickReport, error) {
		ticks.Add(1)
		return TickReport{}, nil
	}}
	rt.Dispatch("T/P")
	wg.Wait()
	rt.Dispatch("T/P")
	wg.Wait()
	if ticks.Load() != 2 {
		t.Fatalf("ticks = %d", ticks.Load())
	}
}

func TestAStaleEntryIsReplacedAndItsOwnerLeavesTheNewOne(t *testing.T) {
	var clock atomic.Int64
	store := &fakeRuntimeStore{}
	g := newGate()
	var wg sync.WaitGroup
	rt := &Runtime{Store: store, Tick: g.tick, Spawn: syncSpawn(&wg), Budget: 20 * time.Second,
		Monotonic: func() time.Duration { return time.Duration(clock.Load()) }}

	rt.Dispatch("T/P")
	<-g.entered
	clock.Store(int64(21 * time.Second)) // the first tick outlived its budget
	rt.Dispatch("T/P")                   // not live any more: a fresh tick, not a rescan
	<-g.entered
	g.release <- struct{}{} // whichever finishes first must not remove the other's entry
	time.Sleep(20 * time.Millisecond)
	rt.mu.Lock()
	remaining := len(rt.running)
	rt.mu.Unlock()
	if remaining != 1 {
		t.Fatalf("running entries after one owner finished: %d, want 1", remaining)
	}
	g.release <- struct{}{}
	wg.Wait()
	if got := store.sources(); len(got) != 2 {
		t.Fatalf("attempts %v, want two (no rescan)", got)
	}
}

func TestAFailedTickStillRunsTheRescanItOwes(t *testing.T) {
	store := &fakeRuntimeStore{}
	var wg sync.WaitGroup
	calls := atomic.Int32{}
	var rt *Runtime
	var reported atomic.Value
	rt = &Runtime{Store: store, Spawn: syncSpawn(&wg), OnError: func(err error) { reported.Store(err) },
		Tick: func(context.Context, string) (TickReport, error) {
			if calls.Add(1) == 1 {
				rt.Dispatch("T/P") //nolint:contextcheck // a write lands during the failing tick
				return TickReport{}, errors.New("boom")
			}
			return TickReport{}, errors.New("again")
		}}
	rt.Dispatch("T/P")
	wg.Wait()
	if calls.Load() != 2 {
		t.Fatalf("ticks = %d, want the failing one and its rescan", calls.Load())
	}
	if err, _ := reported.Load().(error); err == nil || err.Error() != "again" {
		t.Fatalf("reported %v, want the last attempt's error", err)
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	for _, f := range store.finished {
		if f != "failed:processing_failed" {
			t.Fatalf("finished %v", store.finished)
		}
	}
}

func TestConcurrentWritesNeverRunTwoLoopsOfOneTenant(t *testing.T) {
	store := &fakeRuntimeStore{}
	var wg sync.WaitGroup
	var active, peak atomic.Int32
	rt := &Runtime{Store: store, Spawn: syncSpawn(&wg), Tick: func(context.Context, string) (TickReport, error) {
		n := active.Add(1)
		for {
			p := peak.Load()
			if n <= p || peak.CompareAndSwap(p, n) {
				break
			}
		}
		time.Sleep(time.Millisecond)
		active.Add(-1)
		return TickReport{}, nil
	}}
	var writers sync.WaitGroup
	for range 64 {
		writers.Add(1)
		go func() { defer writers.Done(); rt.Dispatch("T/P") }()
	}
	writers.Wait()
	wg.Wait()
	if peak.Load() != 1 {
		t.Fatalf("%d ticks of one tenant ran at once in this process", peak.Load())
	}
}

func TestScheduledRunsDueTenantsWithinTheBudgetAndJoinsErrors(t *testing.T) {
	var clock atomic.Int64
	store := &fakeRuntimeStore{tenants: []string{"A/1", "B/2", "C/3"}}
	rt := &Runtime{Store: store, Budget: 10 * time.Second,
		Monotonic: func() time.Duration { return time.Duration(clock.Load()) },
		Tick: func(_ context.Context, tenant string) (TickReport, error) {
			clock.Add(int64(6 * time.Second))
			if tenant == "A/1" {
				return TickReport{}, errors.New("A failed")
			}
			return TickReport{Tenants: 1, Queued: 2}, nil
		}}
	report, err := rt.Scheduled(context.Background())
	if err == nil || err.Error() != "A failed" {
		t.Fatalf("err = %v", err)
	}
	if report != (TickReport{Tenants: 1, Queued: 2}) {
		t.Fatalf("report %+v: C/3 is past the budget", report)
	}
	if got := store.sources(); len(got) != 2 || got[0] != SourceCron {
		t.Fatalf("attempts %v", got)
	}
}

func TestACronRunWhileAnEventTickIsLiveIsAPlainConcurrentAttempt(t *testing.T) {
	store := &fakeRuntimeStore{tenants: []string{"T/P"}}
	g := newGate()
	var wg sync.WaitGroup
	rt := &Runtime{Store: store, Tick: g.tick, Spawn: syncSpawn(&wg)}
	rt.Dispatch("T/P")
	<-g.entered
	done := make(chan struct{})
	go func() {
		_, _ = rt.Scheduled(context.Background())
		close(done)
	}()
	<-g.entered // the cron attempt runs alongside; the database serializes them
	g.release <- struct{}{}
	g.release <- struct{}{}
	<-done
	wg.Wait()
	if got := store.sources(); len(got) != 2 {
		t.Fatalf("attempts %v", got)
	}
}
