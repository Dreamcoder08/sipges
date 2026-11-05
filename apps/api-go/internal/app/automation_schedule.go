package app

import (
	"context"
	"log/slog"
	"slices"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/automation/application"
)

// logTickFailure reports what failed in a visit: how many failures, and their classes. Their text
// may name a feed or a channel, so it stays out of the log.
func logTickFailure(log *slog.Logger, err error) {
	failures := application.Failures(err)
	log.LogAttrs(context.Background(), slog.LevelError, "automation_tick_failed",
		slog.Int("failures", len(failures)),
		slog.String("classes", strings.Join(slices.Compact(slices.Clone(failures)), ",")))
}

// StartAutomationSchedule starts the cron on pool, as the timer of apps/api/src/main.ts does.
// Without SIPGES_GO_AUTOMATION_CRON it does nothing. Cancelling stop ends it, and DrainBackground
// then waits for the tick in flight.
func StartAutomationSchedule(stop context.Context, pool *pgxpool.Pool, log *slog.Logger) {
	automationMu.Lock()
	m := automationModules[pool]
	automationMu.Unlock()
	if m == nil || m.interval == 0 {
		return
	}
	seconds := int64(m.interval / time.Second)
	m.runtime.StartSchedule(stop, application.Schedule{
		Interval: m.interval,
		OnError:  func(err error) { logTickFailure(log, err) }, //nolint:contextcheck // a log line outlives the stop signal
		OnSkip: func(ran time.Duration) {
			log.LogAttrs(stop, slog.LevelWarn, "automation_tick_skipped",
				slog.String("reason", "previous tick still running"),
				slog.Int64("running_for_ms", ran.Milliseconds()),
				slog.Int64("interval_seconds", seconds))
		},
	})
	log.LogAttrs(stop, slog.LevelInfo, "automation_schedule_started", slog.Int64("interval_seconds", seconds))
}
