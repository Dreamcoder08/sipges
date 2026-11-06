package application

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"sync"
	"sync/atomic"
	"time"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/database"
)

// The automation runtime: apps/api/src/contexts/system/application/automation-runtime.ts.

// RuntimeSource is who started an attempt: a committed write (event) or the scheduler (cron).
type RuntimeSource string

// Runtime sources.
const (
	SourceEvent RuntimeSource = "event"
	SourceCron  RuntimeSource = "cron"
)

// MaxRescans is MAX_RESCANS: follow-up scans one tick runs for writes that arrived during it.
const MaxRescans = 2

// DefaultBudget is the runtime's default budget (budgetMs ?? 20000).
const DefaultBudget = 20 * time.Second

// finishTimeout bounds recording an attempt's end.
const finishTimeout = 5 * time.Second

// TickReport is TickReport, in the field order of the contract.
type TickReport struct {
	Tenants   int64 `json:"tenants"`
	Scanned   int64 `json:"scanned"`
	Queued    int64 `json:"queued"`
	Delivered int64 `json:"delivered"`
	Retrying  int64 `json:"retrying"`
	Failed    int64 `json:"failed"`
}

func (r *TickReport) add(o TickReport) {
	r.Tenants += o.Tenants
	r.Scanned += o.Scanned
	r.Queued += o.Queued
	r.Delivered += o.Delivered
	r.Retrying += o.Retrying
	r.Failed += o.Failed
}

// Attempt is RuntimeAttempt: the latest attempt recorded on the tenant's cursor.
type Attempt struct {
	StartedAt  time.Time
	FinishedAt *time.Time
	Source     RuntimeSource
	Status     string
	Report     *TickReport
	// ReportJSON is the stored report as the column holds it, for the route that shows it.
	ReportJSON json.RawMessage
	Error      string
}

// RuntimeStore is RuntimeStore: attempt bookkeeping on automation_cursors.
type RuntimeStore interface {
	DueTenants(ctx context.Context, limit int) ([]string, error)
	Start(ctx context.Context, tenantID, token string, source RuntimeSource, at time.Time) error
	Finish(ctx context.Context, tenantID, token, status string, report *TickReport, errText string, at time.Time) error
}

// Runtime is createAutomationRuntime: bounded, durable worker coordination per tenant.
//
// Ticks running in this process are tracked in a map. Nothing ever waits for a tick another
// request started: a write that finds one running asks it for one more scan. The database
// serializes concurrent scans (the cursor row lock) and claims (FOR UPDATE SKIP LOCKED), so
// ticks of this process, of other Go processes and of the TypeScript API may overlap safely.
type Runtime struct {
	Store RuntimeStore
	// Tick runs one tenant's tick (Service.Tick).
	Tick func(ctx context.Context, tenantID string) (TickReport, error)
	// BeforeTick runs before a cron tick (TypeScript polls public sources and media feeds
	// there); nil skips it.
	BeforeTick func(ctx context.Context, tenantID string, source RuntimeSource) error
	// Now is the wall clock recorded on the cursor; nil means time.Now.
	Now func() time.Time
	// Monotonic is the clock budgets are measured on (performance.now); nil means the time
	// since the process started.
	Monotonic func() time.Duration
	// Budget is how long a tick counts as live; zero means DefaultBudget.
	Budget time.Duration
	// Background is the context ticks of no request run in (the worker's actor); nil means
	// context.Background.
	Background func() context.Context
	// TaskTimeout bounds an event tick started in the background and each tenant of a visit;
	// zero means no bound.
	TaskTimeout time.Duration
	// OnError reports a failed event tick (automation_processing_failed).
	OnError func(err error)
	// Spawn runs an event tick without blocking the request; nil means a goroutine.
	Spawn func(task func())

	mu      sync.Mutex
	running map[string]*entry
	// tasks counts the event ticks Dispatch started, the ticks routes run and the schedule, so Drain
	// can wait for them.
	tasks sync.WaitGroup
	// stop is the schedule's stop signal, nil without a schedule.
	stop atomic.Pointer[context.Context]
}

// entry is one tick of this process: rescan is set by writes that arrive while it runs.
type entry struct {
	rescan    bool
	startedAt time.Duration
}

var processStart = time.Now()

func (rt *Runtime) budget() time.Duration {
	if rt.Budget > 0 {
		return rt.Budget
	}
	return DefaultBudget
}

func (rt *Runtime) now() time.Time {
	if rt.Now != nil {
		return rt.Now()
	}
	return time.Now()
}

func (rt *Runtime) mono() time.Duration {
	if rt.Monotonic != nil {
		return rt.Monotonic()
	}
	return time.Since(processStart)
}

// live returns the tenant's entry while it is within its budget; the caller holds mu. A tick
// that outlived its budget belongs to a request that ended or was cancelled.
func (rt *Runtime) live(tenantID string) *entry {
	e := rt.running[tenantID]
	if e != nil && rt.mono()-e.startedAt <= rt.budget() {
		return e
	}
	return nil
}

func newToken() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	h := hex.EncodeToString(b[:])
	return h[:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:]
}

// attempt records one attempt on the cursor around the tick.
func (rt *Runtime) attempt(ctx context.Context, tenantID string, source RuntimeSource) (TickReport, error) {
	token := newToken()
	if err := rt.Store.Start(ctx, tenantID, token, source, rt.now()); err != nil {
		return TickReport{}, failure{ErrStore, err}
	}
	var preparation error
	if rt.BeforeTick != nil {
		preparation = rt.prepare(ctx, tenantID, source)
	}
	report, err := rt.tick(ctx, tenantID)
	if err == nil {
		err = preparation
	}
	if err != nil {
		if finishErr := rt.finish(ctx, tenantID, token, "failed", nil, "processing_failed"); finishErr != nil {
			// The tick's failure stays the cause: its chain, and so its class, is what counts.
			return TickReport{}, failure{finishErr, err}
		}
		return TickReport{}, err
	}
	if err := rt.finish(ctx, tenantID, token, "completed", &report, ""); err != nil {
		return TickReport{}, failure{ErrStore, err}
	}
	return report, nil
}

// finish records the attempt's end on a context of its own: a tick cut by its bound must still
// end its attempt, or the cursor stays running.
func (rt *Runtime) finish(ctx context.Context, tenantID, token, status string, report *TickReport, errText string) error {
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), finishTimeout)
	defer cancel()
	return rt.Store.Finish(ctx, tenantID, token, status, report, errText, rt.now())
}

// tick is Tick with a panic as its error: the attempt ends failed, the tick stops counting as
// live, and the other tenants of a visit still run.
func (rt *Runtime) tick(ctx context.Context, tenantID string) (report TickReport, err error) {
	defer func() {
		if r := recover(); r != nil {
			report, err = TickReport{}, panicked(r)
		}
	}()
	report, err = rt.Tick(ctx, tenantID)
	if err != nil {
		return report, failure{ErrRules, err}
	}
	return report, nil
}

// register makes a new entry the tenant's live tick, unless one is live already, in which case
// rescan (a committed write) asks that one for another scan. The check and the registration
// are one critical section, as they are one synchronous step in JavaScript.
func (rt *Runtime) register(tenantID string, rescan bool) (*entry, bool) {
	rt.mu.Lock()
	defer rt.mu.Unlock()
	if live := rt.live(tenantID); live != nil {
		if rescan {
			live.rescan = true
		}
		return nil, false
	}
	if rt.running == nil {
		rt.running = map[string]*entry{}
	}
	e := &entry{startedAt: rt.mono()}
	rt.running[tenantID] = e
	return e, true
}

// loop is the body of run once e is registered: a tick of its own, then the rescans writes
// asked for meanwhile, at most MaxRescans so one request is not kept alive by a stream of
// writes (cron catches up). The entry is removed by its owner only, in the same critical
// section as the last rescan check, so no request's rescan is lost between the two.
func (rt *Runtime) loop(ctx context.Context, tenantID string, source RuntimeSource, e *entry) (TickReport, error) {
	next := source
	var panicErr error
	for rounds := 1; ; rounds++ {
		rt.mu.Lock()
		e.rescan = false
		rt.mu.Unlock()
		report, err := rt.attempt(ctx, tenantID, next)
		next = SourceEvent
		if panicErr == nil && errors.Is(err, ErrPanicked) {
			panicErr = err
		}
		rt.mu.Lock()
		// A rescan on an ended context could only fail in its place; the next tick catches up.
		again := e.rescan && rounds <= MaxRescans && !rt.stopping() && ctx.Err() == nil
		if !again && rt.running[tenantID] == e {
			// A fresh tick may have replaced a stale entry; only the owner removes its own.
			delete(rt.running, tenantID)
		}
		rt.mu.Unlock()
		if !again {
			if panicErr != nil {
				err = panicErr // a later round does not undo a panic: its send may repeat
			}
			return report, err // a failed tick still owed the rescans asked before it ended
		}
	}
}

// Run is run: a tick of the tenant, or a concurrent attempt when one is live here already.
func (rt *Runtime) Run(ctx context.Context, tenantID string, source RuntimeSource) (TickReport, error) {
	e, ok := rt.register(tenantID, false)
	if !ok {
		return rt.attempt(ctx, tenantID, source)
	}
	return rt.loop(ctx, tenantID, source, e)
}

// Dispatch is dispatch: a committed write needs a scan after it. A tick already live here
// rescans; otherwise an event tick starts in the background and the caller does not wait.
func (rt *Runtime) Dispatch(tenantID string) {
	e, ok := rt.register(tenantID, true)
	if !ok {
		return
	}
	rt.tasks.Add(1)
	task := func() {
		defer rt.tasks.Done()
		defer func() {
			if r := recover(); r != nil && rt.OnError != nil {
				rt.OnError(panicked(r))
			}
		}()
		ctx, cancel := rt.bounded(rt.background())
		defer cancel()
		if _, err := rt.loop(ctx, tenantID, SourceEvent, e); err != nil && rt.OnError != nil {
			rt.OnError(err)
		}
	}
	if rt.Spawn != nil {
		rt.Spawn(task)
		return
	}
	go task()
}

// background is the context of work no request waits for.
func (rt *Runtime) background() context.Context {
	if rt.Background != nil {
		return rt.Background()
	}
	return context.Background()
}

// bounded applies TaskTimeout to one tenant's tick, or to the listing of the tenants.
func (rt *Runtime) bounded(ctx context.Context) (context.Context, context.CancelFunc) {
	if rt.TaskTimeout > 0 {
		return context.WithTimeout(ctx, rt.TaskTimeout)
	}
	return ctx, func() {}
}

// visit is one tenant's tick of a schedule, on its own bound: a late tenant keeps the whole of it,
// and is not cut between sending and FinishRun by the time earlier tenants took.
func (rt *Runtime) visit(ctx context.Context, tenantID string) (TickReport, error) {
	ctx, cancel := rt.bounded(ctx)
	defer cancel()
	return rt.Run(ctx, tenantID, SourceCron)
}

func (rt *Runtime) dueTenants(ctx context.Context) ([]string, error) {
	ctx, cancel := rt.bounded(ctx)
	defer cancel()
	tenants, err := rt.Store.DueTenants(ctx, 100)
	if err != nil {
		return nil, failure{ErrStore, err}
	}
	return tenants, nil
}

// Drain waits until the event ticks Dispatch started, the ticks routes run and a stopped schedule
// have finished, or ctx ends. A process shutting down calls it after the server stopped and before closing the
// pool: a tick cut off between sending and FinishRun would send its message again when the lease
// expires, and most channels do not deduplicate. In Node, the wakeup awaits its tick inside the
// request.
func (rt *Runtime) Drain(ctx context.Context) error {
	done := make(chan struct{})
	go func() {
		rt.tasks.Wait()
		close(done)
	}()
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// Scheduled is scheduled: every due tenant in turn within one budget, the reports summed. A
// tenant that fails does not stop the others; their errors are joined. A caller's tick counts for
// Drain, and a schedule that stopped ends the visit, like its own ticks.
func (rt *Runtime) Scheduled(ctx context.Context) (TickReport, error) {
	rt.tasks.Add(1)
	defer rt.tasks.Done()
	var stop <-chan struct{}
	if signal := rt.stop.Load(); signal != nil {
		stop = (*signal).Done()
	}
	return rt.scheduled(ctx, stop)
}

// TickNow is one tick a request asked for: no attempt is recorded, and Drain waits for it.
func (rt *Runtime) TickNow(ctx context.Context, tenantID string) (TickReport, error) {
	rt.tasks.Add(1)
	defer rt.tasks.Done()
	return rt.Tick(ctx, tenantID)
}

// scheduled is Scheduled that visits no further tenant once stop closes.
func (rt *Runtime) scheduled(ctx context.Context, stop <-chan struct{}) (TickReport, error) {
	deadline := rt.mono() + rt.budget()
	var total TickReport
	tenants, err := rt.dueTenants(ctx)
	if err != nil {
		return total, err
	}
	var errs []error
	for _, tenantID := range tenants {
		if rt.mono() >= deadline || closed(stop) {
			break
		}
		report, err := rt.visit(ctx, tenantID)
		if err != nil {
			errs = append(errs, err)
			continue
		}
		total.add(report)
	}
	return total, errors.Join(errs...)
}

func closed(c <-chan struct{}) bool {
	select {
	case <-c:
		return true
	default:
		return false
	}
}

// WorkerContext is ctx running as the automation worker: actor 'automation' with full
// clearance, as the TypeScript composition root runs ticks (runWithRequestContext).
func WorkerContext(ctx context.Context) context.Context {
	return database.WithActor(ctx, database.Actor{Name: "automation", Clearance: database.ClearanceFull})
}
