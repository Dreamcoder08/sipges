package app

import (
	"context"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/automation/application"
	integration "github.com/Dreamcoder08/sipges/apps/api-go/internal/integration/application"
)

// EgressGuard exposes the guard's composition to the integration tests.
var EgressGuard = egressGuard

// SetGoogleTransport makes the composition reach Google through rt; the result restores it.
func SetGoogleTransport(rt http.RoundTripper) func() {
	previous := googleTransport
	googleTransport = rt
	return func() { googleTransport = previous }
}

// CronRunner composes a runtime as the automation context does, on the given gateways and tick;
// a zero interval is the flag off.
func CronRunner(pool *pgxpool.Pool, interval time.Duration, feeds integration.FeedGateway, official integration.OfficialGateway,
	tick func(context.Context, string) (application.TickReport, error),
) *application.Runtime {
	rt := automationRuntime(Deps{Pool: pool, AutomationInterval: interval}, application.Service{}, feeds, official)
	rt.Tick = tick
	return rt
}

// LogTickFailure exposes how the schedule logs a failed visit.
var LogTickFailure = logTickFailure
