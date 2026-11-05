package application

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

const scheduleWait = 5 * time.Second

func received(t *testing.T, c <-chan struct{}, what string) {
	t.Helper()
	select {
	case <-c:
	case <-time.After(scheduleWait):
		t.Fatal("timed out waiting for " + what)
	}
}

func TestTheScheduleRunsCronTicksEveryInterval(t *testing.T) {
	store := &fakeRuntimeStore{tenants: []string{"T/P"}}
	ticks := make(chan struct{}, 8)
	rt := &Runtime{Store: store, Tick: func(context.Context, string) (TickReport, error) {
		ticks <- struct{}{}
		return TickReport{Tenants: 1}, nil
	}}
	stop, cancel := context.WithCancel(context.Background())
	defer cancel()

	rt.StartSchedule(stop, Schedule{Interval: 5 * time.Millisecond})
	received(t, ticks, "the first tick")
	received(t, ticks, "the second tick")
	cancel()
	if err := rt.Drain(t.Context()); err != nil {
		t.Fatal(err)
	}
	for _, source := range store.sources() {
		if source != SourceCron {
			t.Fatalf("sources %v, want cron only", store.sources())
		}
	}
}

func TestTheScheduleWaitsOneIntervalBeforeItsFirstTick(t *testing.T) {
	store := &fakeRuntimeStore{tenants: []string{"T/P"}}
	var ticks atomic.Int64
	rt := &Runtime{Store: store, Tick: func(context.Context, string) (TickReport, error) {
		ticks.Add(1)
		return TickReport{}, nil
	}}
	stop, cancel := context.WithCancel(context.Background())
	rt.StartSchedule(stop, Schedule{Interval: time.Hour})
	cancel()
	if err := rt.Drain(t.Context()); err != nil {
		t.Fatal(err)
	}
	if ticks.Load() != 0 {
		t.Fatalf("%d ticks, want none: setInterval does not fire at start", ticks.Load())
	}
}

func TestASlowTickIsSkippedOverNotOverlapped(t *testing.T) {
	store := &fakeRuntimeStore{tenants: []string{"T/P"}}
	g := newGate()
	skipped := make(chan time.Duration, 1)
	var running, most atomic.Int64
	rt := &Runtime{Store: store, Tick: func(ctx context.Context, tenant string) (TickReport, error) {
		if n := running.Add(1); n > most.Load() {
			most.Store(n)
		}
		defer running.Add(-1)
		return g.tick(ctx, tenant)
	}}
	stop, cancel := context.WithCancel(context.Background())
	defer cancel()
	const interval = 5 * time.Millisecond
	rt.StartSchedule(stop, Schedule{Interval: interval, OnSkip: func(ran time.Duration) {
		select {
		case skipped <- ran:
		default:
		}
	}})
	received(t, g.entered, "the slow tick")
	time.Sleep(6 * interval) //nolint:forbidigo // intervals must pass while the tick runs
	g.release <- struct{}{}
	select {
	case ran := <-skipped:
		if ran < interval {
			t.Fatalf("reported %v, want at least the interval", ran)
		}
	case <-time.After(scheduleWait):
		t.Fatal("the slow tick was not reported")
	}
	received(t, g.entered, "the tick after it")
	cancel()
	g.release <- struct{}{}
	if err := rt.Drain(t.Context()); err != nil {
		t.Fatal(err)
	}
	if most.Load() != 1 {
		t.Fatalf("%d scheduled ticks ran at once, want 1", most.Load())
	}
}

func TestStoppingLeavesTheNextTenantsAndDrainWaitsForTheTickInFlight(t *testing.T) {
	store := &fakeRuntimeStore{tenants: []string{"T/A", "T/B"}}
	g := newGate()
	var mu sync.Mutex
	var visited []string
	var cut atomic.Bool
	rt := &Runtime{Store: store, Tick: func(ctx context.Context, tenant string) (TickReport, error) {
		mu.Lock()
		visited = append(visited, tenant)
		mu.Unlock()
		report, err := g.tick(ctx, tenant)
		// The tick between Send and FinishRun: its context must outlive the signal.
		cut.Store(ctx.Err() != nil)
		return report, err
	}}
	stop, cancel := context.WithCancel(context.Background())
	defer cancel()
	rt.StartSchedule(stop, Schedule{Interval: 5 * time.Millisecond})
	received(t, g.entered, "the first tenant")

	cancel()
	short, done := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer done()
	if err := rt.Drain(short); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("drain with a tick in flight: %v", err)
	}
	g.release <- struct{}{}
	if err := rt.Drain(t.Context()); err != nil {
		t.Fatal(err)
	}
	if cut.Load() {
		t.Fatal("the signal cancelled the tick in flight")
	}
	mu.Lock()
	defer mu.Unlock()
	if len(visited) != 1 || visited[0] != "T/A" {
		t.Fatalf("visited %v, want only the tenant in flight", visited)
	}
	if store.finished[0] != "completed:" {
		t.Fatalf("finished %v", store.finished)
	}
}

func TestStoppingCutsThePollingShortButTheTickStillRuns(t *testing.T) {
	store := &fakeRuntimeStore{tenants: []string{"T/P"}}
	polling := make(chan struct{})
	ticked := make(chan error, 1)
	failures := make(chan error, 1)
	rt := &Runtime{
		Store: store,
		BeforeTick: func(ctx context.Context, _ string, _ RuntimeSource) error {
			close(polling)
			<-ctx.Done()
			return ctx.Err()
		},
		Tick: func(ctx context.Context, _ string) (TickReport, error) {
			ticked <- ctx.Err()
			return TickReport{}, nil
		},
	}
	stop, cancel := context.WithCancel(context.Background())
	defer cancel()
	rt.StartSchedule(stop, Schedule{Interval: 5 * time.Millisecond, OnError: func(err error) { failures <- err }})
	received(t, polling, "the polling")
	cancel()
	if err := rt.Drain(t.Context()); err != nil {
		t.Fatal(err)
	}
	if err := <-ticked; err != nil {
		t.Fatalf("the tick after the polling saw a cancelled context: %v", err)
	}
	if err := <-failures; !errors.Is(err, context.Canceled) {
		t.Fatalf("failure %v, want the polling's", err)
	}
}

func TestAFailedOrPanickingTickIsReportedAndTheScheduleGoesOn(t *testing.T) {
	store := &fakeRuntimeStore{tenants: []string{"T/P"}}
	failures := make(chan error, 8)
	healthy := make(chan struct{}, 8)
	var calls atomic.Int64
	rt := &Runtime{Store: store, Tick: func(context.Context, string) (TickReport, error) {
		switch calls.Add(1) {
		case 1:
			panic("synthetic")
		case 2:
			return TickReport{}, errors.New("synthetic failure")
		}
		healthy <- struct{}{}
		return TickReport{}, nil
	}}
	stop, cancel := context.WithCancel(context.Background())
	defer cancel()
	rt.StartSchedule(stop, Schedule{Interval: 5 * time.Millisecond, OnError: func(err error) { failures <- err }})
	received(t, healthy, "a tick after the failures")
	cancel()
	if err := rt.Drain(t.Context()); err != nil {
		t.Fatal(err)
	}
	if len(failures) < 2 {
		t.Fatalf("%d failures reported, want the panic and the error", len(failures))
	}
}

func TestAScheduleBoundsAHungTickWithTheTaskTimeout(t *testing.T) {
	store := &fakeRuntimeStore{tenants: []string{"T/P"}}
	rt := &Runtime{Store: store, TaskTimeout: 10 * time.Millisecond, Tick: func(ctx context.Context, _ string) (TickReport, error) {
		<-ctx.Done()
		return TickReport{}, ctx.Err()
	}}
	failures := make(chan error, 8)
	stop, cancel := context.WithCancel(context.Background())
	defer cancel()
	rt.StartSchedule(stop, Schedule{Interval: 5 * time.Millisecond, OnError: func(err error) { failures <- err }})
	select {
	case err := <-failures:
		if !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("failure %v", err)
		}
	case <-time.After(scheduleWait):
		t.Fatal("the hung tick was never bounded")
	}
	cancel()
	if err := rt.Drain(t.Context()); err != nil {
		t.Fatal(err)
	}
}

func TestScheduledWithoutAScheduleKeepsVisitingEveryTenant(t *testing.T) {
	store := &fakeRuntimeStore{tenants: []string{"T/A", "T/B"}}
	var ticks atomic.Int64
	rt := &Runtime{Store: store, Tick: func(context.Context, string) (TickReport, error) {
		ticks.Add(1)
		return TickReport{Tenants: 1}, nil
	}}
	if report, err := rt.Scheduled(t.Context()); err != nil || report.Tenants != 2 || ticks.Load() != 2 {
		t.Fatalf("scheduled %+v (%v), %d ticks", report, err, ticks.Load())
	}
}

func TestStoppingDropsTheRescansSoTheTickFitsTheDrain(t *testing.T) {
	store := &fakeRuntimeStore{tenants: []string{"T/P"}}
	g := newGate()
	var wg sync.WaitGroup
	rt := &Runtime{Store: store, Tick: g.tick, Spawn: syncSpawn(&wg)}
	stop, cancel := context.WithCancel(context.Background())
	defer cancel()
	rt.StartSchedule(stop, Schedule{Interval: 5 * time.Millisecond})
	received(t, g.entered, "the cron tick")
	rt.Dispatch("T/P") // a write during the tick asks for a rescan
	cancel()
	g.release <- struct{}{}
	if err := rt.Drain(t.Context()); err != nil {
		t.Fatal(err)
	}
	if got := store.sources(); len(got) != 1 {
		t.Fatalf("attempts %v, want only the tick in flight: the next runner catches up", got)
	}
}

func TestDrainWaitsForACronRouteTickAndStoppingEndsItsTenants(t *testing.T) {
	store := &fakeRuntimeStore{tenants: []string{"T/A", "T/B"}}
	g := newGate()
	rt := &Runtime{Store: store, Tick: g.tick}
	stop, cancel := context.WithCancel(context.Background())
	defer cancel()
	rt.StartSchedule(stop, Schedule{Interval: time.Hour})
	routeDone := make(chan struct{})
	go func() {
		defer close(routeDone)
		_, _ = rt.Scheduled(context.Background()) // POST /system/automations/cron
	}()
	received(t, g.entered, "the route's tick")

	cancel()
	short, done := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer done()
	if err := rt.Drain(short); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("drain with a route tick in flight: %v", err)
	}
	g.release <- struct{}{}
	if err := rt.Drain(t.Context()); err != nil {
		t.Fatal(err)
	}
	received(t, routeDone, "the route")
	if got := store.sources(); len(got) != 1 {
		t.Fatalf("attempts %v, want only the tenant in flight", got)
	}
}

func TestDrainWaitsForATickNow(t *testing.T) {
	store := &fakeRuntimeStore{}
	g := newGate()
	rt := &Runtime{Store: store, Tick: g.tick}
	go func() { _, _ = rt.TickNow(context.Background(), "T/P") }() // POST /system/automations/tick
	received(t, g.entered, "the route's tick")
	short, done := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer done()
	if err := rt.Drain(short); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("drain with a route tick in flight: %v", err)
	}
	g.release <- struct{}{}
	if err := rt.Drain(t.Context()); err != nil {
		t.Fatal(err)
	}
}
