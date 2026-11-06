package http

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/automation/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/automation/domain"
	tenancyhttp "github.com/Dreamcoder08/sipges/apps/api-go/internal/tenancy/http"
)

// RuntimeInfo is what the server says about itself on GET /system/automations/runtime.
type RuntimeInfo struct {
	// CronConfigured is Boolean(cronSecret): the secret exists, whichever API runs the cron.
	CronConfigured bool
	// CronSchedule is SIPGES_CRON_SCHEDULE; nil on a server with no external scheduler.
	CronSchedule *string
	// IntervalMS is this process's own timer; zero when it has none.
	IntervalMS int64
	// Latest reads a tenant's latest attempt; nil when none was recorded.
	Latest func(ctx context.Context, tenantID string) (*application.Attempt, error)
}

// errNoScope is unreachable behind the project scope; the route refuses rather than read nobody's
// attempt.
var errNoScope = errors.New("automation: the request has no project scope")

type runtimeJSON struct {
	EventProcessing bool         `json:"event_processing"`
	CronConfigured  bool         `json:"cron_configured"`
	CronSchedule    *string      `json:"cron_schedule"`
	IntervalMS      int64        `json:"interval_ms"`
	LatestAttempt   *attemptJSON `json:"latest_attempt"`
}

type attemptJSON struct {
	StartedAt  string          `json:"started_at"`
	FinishedAt *string         `json:"finished_at"`
	Source     string          `json:"source"`
	Status     string          `json:"status"`
	Error      string          `json:"error"`
	Report     json.RawMessage `json:"report"`
}

// RuntimeRoutes registers GET /system/automations/runtime (runtime-routes.ts). Event processing
// is always true: the wakeup middleware is mounted on every start, as both TypeScript entry
// points pass eventAutomation.
func RuntimeRoutes(mux *http.ServeMux, opts WriteOptions, info RuntimeInfo) {
	mux.HandleFunc("GET /system/automations/runtime", func(w http.ResponseWriter, r *http.Request) {
		scope, ok := tenancyhttp.ScopeFrom(r.Context())
		if !ok {
			respond(w, r, opts.Logger, nil, errNoScope)
			return
		}
		attempt, err := info.Latest(r.Context(), scope.TenantID())
		var view *attemptJSON
		if err == nil && attempt != nil {
			view, err = toAttempt(*attempt)
		}
		respond(w, r, opts.Logger, runtimeJSON{
			EventProcessing: true,
			CronConfigured:  info.CronConfigured,
			CronSchedule:    info.CronSchedule,
			IntervalMS:      info.IntervalMS,
			LatestAttempt:   view,
		}, err)
	})
}

func toAttempt(a application.Attempt) (*attemptJSON, error) {
	view := attemptJSON{
		StartedAt: domain.ISOMillis(a.StartedAt),
		Source:    string(a.Source),
		Status:    a.Status,
		Error:     a.Error,
		Report:    json.RawMessage("null"),
	}
	if a.FinishedAt != nil {
		finished := domain.ISOMillis(*a.FinishedAt)
		view.FinishedAt = &finished
	}
	if len(a.ReportJSON) > 0 {
		var compact bytes.Buffer
		if err := json.Compact(&compact, a.ReportJSON); err != nil {
			return nil, err
		}
		view.Report = compact.Bytes()
	}
	return &view, nil
}
