package application

import (
	"context"
	"fmt"
	"time"
)

// Schedule is the timer of apps/api/src/main.ts: a setInterval around scheduled(), wrapped in
// skipWhileRunning.
type Schedule struct {
	// Interval is the time between ticks; the first one comes one interval after the start.
	Interval time.Duration
	// OnError reports a failed or panicking run (automation_tick_failed).
	OnError func(err error)
	// OnSkip reports a run that outlasted the interval, with how long it ran
	// (automation_tick_skipped). Runs never overlap: the triggers it covered are dropped.
	OnSkip func(ranFor time.Duration)
}

func (s Schedule) failed(err error) {
	if s.OnError != nil {
		s.OnError(err)
	}
}

// StartSchedule runs Scheduled every s.Interval in the background until stop ends. Stopping
// starts no further tenant and cuts the polling short, which sends nothing; the tick in flight
// keeps its own context, because one cut off between sending and FinishRun would send its message
// again when the lease expires. Drain waits for it, so a shutdown cancels stop and then drains.
func (rt *Runtime) StartSchedule(stop context.Context, s Schedule) {
	rt.stop.Store(&stop)
	rt.tasks.Add(1)
	go func() {
		defer rt.tasks.Done()
		ticker := time.NewTicker(s.Interval)
		defer ticker.Stop()
		for {
			select {
			case <-stop.Done():
				return
			case <-ticker.C:
			}
			if stop.Err() != nil {
				return
			}
			started := rt.mono()
			rt.scheduledTick(stop, s)
			if ran := rt.mono() - started; ran >= s.Interval && s.OnSkip != nil {
				s.OnSkip(ran)
			}
		}
	}()
}

// scheduledTick is one run of the schedule, on a context of its own.
func (rt *Runtime) scheduledTick(stop context.Context, s Schedule) {
	defer func() {
		if r := recover(); r != nil {
			s.failed(fmt.Errorf("scheduled tick panicked: %v", r))
		}
	}()
	ctx, cancel := rt.taskContext()
	defer cancel()
	if _, err := rt.scheduled(ctx, stop.Done()); err != nil { //nolint:contextcheck // on purpose: the signal must not cut a tick
		s.failed(err)
	}
}

// stopping is whether a schedule stopped: a rescan would outlast the drain, and the next runner
// catches up. One tick fits it: the 8 s execution budget plus one 10 s send, within 20 s.
func (rt *Runtime) stopping() bool {
	stop := rt.stop.Load()
	return stop != nil && (*stop).Err() != nil
}

// prepare runs BeforeTick. A schedule that stopped cuts it short: polling sends nothing, and the
// tick after it still fits the drain.
func (rt *Runtime) prepare(ctx context.Context, tenantID string, source RuntimeSource) error {
	if stop := rt.stop.Load(); stop != nil {
		var cancel context.CancelFunc
		ctx, cancel = context.WithCancel(ctx)
		defer cancel()
		defer context.AfterFunc(*stop, cancel)() //nolint:contextcheck // on purpose: ties the polling to the schedule's stop
	}
	return rt.BeforeTick(ctx, tenantID, source)
}
