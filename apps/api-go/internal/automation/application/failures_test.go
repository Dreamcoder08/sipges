package application

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
)

type failingStore struct {
	fakeRuntimeStore
	dueErr, startErr, finishErr error
}

func (f *failingStore) DueTenants(ctx context.Context, n int) ([]string, error) {
	if f.dueErr != nil {
		return nil, f.dueErr
	}
	return f.fakeRuntimeStore.DueTenants(ctx, n)
}

func (f *failingStore) Start(ctx context.Context, tenant, token string, source RuntimeSource, at time.Time) error {
	if f.startErr != nil {
		return f.startErr
	}
	return f.fakeRuntimeStore.Start(ctx, tenant, token, source, at)
}

func (f *failingStore) Finish(ctx context.Context, tenant, token, status string, report *TickReport, text string, at time.Time) error {
	if f.finishErr != nil {
		return f.finishErr
	}
	return f.fakeRuntimeStore.Finish(ctx, tenant, token, status, report, text, at)
}

func TestAPanickingTenantFailsItsAttemptAndTheNextTenantStillRuns(t *testing.T) {
	store := &fakeRuntimeStore{tenants: []string{"T/A", "T/B"}}
	var mu sync.Mutex
	var visited []string
	rt := &Runtime{Store: store, Tick: func(_ context.Context, tenant string) (TickReport, error) {
		mu.Lock()
		visited = append(visited, tenant)
		mu.Unlock()
		if tenant == "T/A" {
			panic("synthetic")
		}
		return TickReport{Tenants: 1}, nil
	}}
	report, err := rt.Scheduled(t.Context())
	if !errors.Is(err, ErrPanicked) {
		t.Fatalf("scheduled: %v", err)
	}
	if report.Tenants != 1 || !reflect.DeepEqual(visited, []string{"T/A", "T/B"}) {
		t.Fatalf("report %+v, visited %v", report, visited)
	}
	if !reflect.DeepEqual(store.finished, []string{"failed:processing_failed", "completed:"}) {
		t.Fatalf("finished %v", store.finished)
	}
	// The panic left no live entry behind: a write gets a tick of its own, not a rescan.
	if _, ok := rt.register("T/A", true); !ok {
		t.Fatal("the panicking tick still counts as live")
	}
}

func TestTheTaskTimeoutStartsAgainForEachTenant(t *testing.T) {
	store := &fakeRuntimeStore{tenants: []string{"T/A", "T/B"}}
	var deadlines []time.Time
	rt := &Runtime{Store: store, TaskTimeout: time.Hour, Tick: func(ctx context.Context, _ string) (TickReport, error) {
		deadline, ok := ctx.Deadline()
		if !ok {
			t.Fatal("a tick without a deadline")
		}
		deadlines = append(deadlines, deadline)
		time.Sleep(2 * time.Millisecond) //nolint:forbidigo // the next tenant's bound must start later
		return TickReport{}, nil
	}}
	stop, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan struct{})
	rt.StartSchedule(stop, Schedule{Interval: time.Millisecond, OnSkip: func(time.Duration) {
		select {
		case <-done:
		default:
			close(done)
		}
	}})
	received(t, done, "a visit")
	cancel()
	if err := rt.Drain(t.Context()); err != nil {
		t.Fatal(err)
	}
	if len(deadlines) < 2 || !deadlines[1].After(deadlines[0]) {
		t.Fatalf("deadlines %v, want one per tenant", deadlines)
	}
}

func TestTheVisitWaitsABoundedTimeForItsTenants(t *testing.T) {
	store := &blockingStore{}
	failures := make(chan error, 8)
	rt := &Runtime{Store: store, TaskTimeout: 10 * time.Millisecond, Tick: func(context.Context, string) (TickReport, error) {
		return TickReport{}, nil
	}}
	stop, cancel := context.WithCancel(context.Background())
	defer cancel()
	rt.StartSchedule(stop, Schedule{Interval: 5 * time.Millisecond, OnError: func(err error) { failures <- err }})
	select {
	case err := <-failures:
		if got := Failures(err); !reflect.DeepEqual(got, []string{"store"}) {
			t.Fatalf("classes %v (%v)", got, err)
		}
	case <-time.After(scheduleWait):
		t.Fatal("a hung tenant list was never bounded")
	}
}

// blockingStore's tenant list hangs until its context ends.
type blockingStore struct{ fakeRuntimeStore }

func (b *blockingStore) DueTenants(ctx context.Context, _ int) ([]string, error) {
	<-ctx.Done()
	return nil, ctx.Err()
}

func TestFailuresAreClassifiedWithoutTheirText(t *testing.T) {
	boom := errors.New("https://fuente.example.org/secreta")
	ok := func(context.Context, string) (TickReport, error) { return TickReport{}, nil }
	polled := func(err error) func(context.Context, string, RuntimeSource) error {
		return func(context.Context, string, RuntimeSource) error { return err }
	}
	for name, c := range map[string]struct {
		rt   *Runtime
		want []string
	}{
		"rules": {&Runtime{Store: &fakeRuntimeStore{tenants: []string{"T/A"}},
			Tick: func(context.Context, string) (TickReport, error) { return TickReport{}, boom }}, []string{"rules"}},
		"timeout": {&Runtime{Store: &fakeRuntimeStore{tenants: []string{"T/A"}},
			Tick: func(context.Context, string) (TickReport, error) { return TickReport{}, context.DeadlineExceeded }}, []string{"timeout"}},
		"panic": {&Runtime{Store: &fakeRuntimeStore{tenants: []string{"T/A"}},
			Tick: func(context.Context, string) (TickReport, error) { panic(boom) }}, []string{"panic"}},
		"polling": {&Runtime{Store: &fakeRuntimeStore{tenants: []string{"T/A"}}, Tick: ok, BeforeTick: polled(boom)}, []string{"polling"}},
		"polling cut by the shutdown": {&Runtime{Store: &fakeRuntimeStore{tenants: []string{"T/A"}}, Tick: ok,
			BeforeTick: polled(context.Canceled)}, []string{"polling_cancelled"}},
		"polling that panicked": {&Runtime{Store: &fakeRuntimeStore{tenants: []string{"T/A"}}, Tick: ok,
			BeforeTick: func(context.Context, string, RuntimeSource) error { panic(boom) }}, []string{"panic"}},
		"tenant list": {&Runtime{Store: &failingStore{dueErr: boom}, Tick: ok}, []string{"store"}},
		"attempt":     {&Runtime{Store: &failingStore{fakeRuntimeStore: fakeRuntimeStore{tenants: []string{"T/A"}}, startErr: boom}, Tick: ok}, []string{"store"}},
		"attempt end": {&Runtime{Store: &failingStore{fakeRuntimeStore: fakeRuntimeStore{tenants: []string{"T/A"}}, finishErr: boom}, Tick: ok}, []string{"store"}},
		"each tenant": {&Runtime{Store: &fakeRuntimeStore{tenants: []string{"T/A", "T/B"}}, Tick: func(_ context.Context, tenant string) (TickReport, error) {
			if tenant == "T/A" {
				panic(boom)
			}
			return TickReport{}, boom
		}}, []string{"panic", "rules"}},
	} {
		_, err := c.rt.Scheduled(t.Context())
		got := Failures(err)
		if !reflect.DeepEqual(got, c.want) {
			t.Errorf("%s: classes %v, want %v (%v)", name, got, c.want, err)
		}
		if strings.Contains(strings.Join(got, ","), "secreta") {
			t.Errorf("%s: the text reached the class: %v", name, got)
		}
	}
	if got := Failures(nil); got != nil {
		t.Fatalf("no failure: %v", got)
	}
}

// ctxStore fails on an ended context, as the SQL store does.
type ctxStore struct{ fakeRuntimeStore }

func (c *ctxStore) Finish(ctx context.Context, tenant, token, status string, report *TickReport, text string, at time.Time) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	return c.fakeRuntimeStore.Finish(ctx, tenant, token, status, report, text, at)
}

func TestAPanicIsReportedEvenWhenARescanSucceedsAfterIt(t *testing.T) {
	store := &fakeRuntimeStore{tenants: []string{"T/P"}}
	rt := &Runtime{Store: store}
	var calls int
	rt.Tick = func(context.Context, string) (TickReport, error) {
		calls++
		if calls == 1 {
			rt.Dispatch("T/P") //nolint:contextcheck // a write during the tick asks for a rescan
			panic("synthetic")
		}
		return TickReport{Tenants: 1}, nil
	}
	_, err := rt.Scheduled(t.Context())
	if !errors.Is(err, ErrPanicked) {
		t.Fatalf("scheduled: %v, want the panic of the first round", err)
	}
	if calls != 2 {
		t.Fatalf("%d rounds, want the rescan too", calls)
	}
}

func TestAnEventTickReportsAPanicEvenWhenARescanSucceedsAfterIt(t *testing.T) {
	store := &fakeRuntimeStore{}
	var wg sync.WaitGroup
	var reported error
	rt := &Runtime{Store: store, Spawn: syncSpawn(&wg), OnError: func(err error) { reported = err }}
	var calls int
	rt.Tick = func(context.Context, string) (TickReport, error) {
		calls++
		if calls == 1 {
			rt.Dispatch("T/P") //nolint:contextcheck // a write during the tick
			panic("synthetic")
		}
		return TickReport{}, nil
	}
	rt.Dispatch("T/P")
	wg.Wait()
	if !errors.Is(reported, ErrPanicked) {
		t.Fatalf("reported %v", reported)
	}
}

func TestATickCutByItsTimeoutStillRecordsItsEndAndItsClass(t *testing.T) {
	for name, c := range map[string]struct {
		tick func(context.Context, string) (TickReport, error)
		want string
	}{
		"hung": {func(ctx context.Context, _ string) (TickReport, error) {
			<-ctx.Done()
			return TickReport{}, ctx.Err()
		}, "timeout"},
		"panic after the timeout": {func(ctx context.Context, _ string) (TickReport, error) {
			<-ctx.Done()
			panic("synthetic")
		}, "panic"},
	} {
		store := &ctxStore{fakeRuntimeStore{tenants: []string{"T/P"}}}
		rt := &Runtime{Store: store, TaskTimeout: 10 * time.Millisecond, Tick: c.tick}
		_, err := rt.Scheduled(t.Context())
		if got := Failures(err); !reflect.DeepEqual(got, []string{c.want}) {
			t.Errorf("%s: classes %v (%v)", name, got, err)
		}
		if !reflect.DeepEqual(store.finished, []string{"failed:processing_failed"}) {
			t.Errorf("%s: finished %v: the cursor must not stay running", name, store.finished)
		}
	}
}

func TestATenantCountsOneFailureEvenWithAJoinedError(t *testing.T) {
	store := &fakeRuntimeStore{tenants: []string{"T/P"}}
	rt := &Runtime{Store: store, Tick: func(context.Context, string) (TickReport, error) {
		// database.WithTenant joins the work's error with the rollback's.
		return TickReport{}, errors.Join(context.DeadlineExceeded, errors.New("conn closed"))
	}}
	_, err := rt.Scheduled(t.Context())
	if got := Failures(err); !reflect.DeepEqual(got, []string{"timeout"}) {
		t.Fatalf("classes %v (%v)", got, err)
	}
}
