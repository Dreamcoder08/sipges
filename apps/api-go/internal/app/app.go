// Package app composes the Go API's handler: the platform middleware, the identity and tenancy
// gates in the TypeScript API's order (session, project scope, role gate), and the routes.
package app

import (
	"context"
	"log/slog"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	geographyhttp "github.com/Dreamcoder08/sipges/apps/api-go/internal/geography/http"
	identityhttp "github.com/Dreamcoder08/sipges/apps/api-go/internal/identity/http"
	identity "github.com/Dreamcoder08/sipges/apps/api-go/internal/identity/infrastructure"
	integrationhttp "github.com/Dreamcoder08/sipges/apps/api-go/internal/integration/http"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/database"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/engines"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/httpx"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/tenancy/application"
	tenancyhttp "github.com/Dreamcoder08/sipges/apps/api-go/internal/tenancy/http"
	tenancy "github.com/Dreamcoder08/sipges/apps/api-go/internal/tenancy/infrastructure"
)

// Options configures NewHandler.
type Options struct {
	Logger       *slog.Logger
	AllowedHosts []string
	AccessLog    bool
	RequireMFA   bool
	// GoogleEnabled is what GET /system/auth/providers reports.
	GoogleEnabled bool
	// Now is the clock for session expiry, the grant cache and "today" in prevention and
	// situations; nil means time.Now.
	Now func() time.Time
	// Engines are the compiled Rust engines; nil means engines.Shared.
	Engines *engines.Set
	// AutomationInterval is config.Config's: zero leaves the cron to TypeScript.
	AutomationInterval time.Duration
	// WebDir is config.Config's: Go serves the SPA and adds the security headers itself.
	WebDir string
	// HSTS is config.Config's CookieSecure; it matters only with WebDir.
	HSTS bool
	// ReadyGate holds /health/ready at 503 until it answers nil; nil means no gate.
	ReadyGate httpx.ReadyFunc
	// Routes adds routes beyond the ones registered here (tests).
	Routes func(mux *http.ServeMux)
}

// NewHandler builds the API on pool. It fails only when the embedded reference files do not
// match their contract or WebDir cannot be opened.
func NewHandler(pool *pgxpool.Pool, opts Options) (http.Handler, error) {
	if opts.Engines == nil {
		compiled, err := engines.Shared(context.Background())
		if err != nil {
			return nil, err
		}
		opts.Engines = compiled
	}
	deps := Deps{Pool: pool, Logger: opts.Logger, Now: opts.Now, Engines: opts.Engines, AutomationInterval: opts.AutomationInterval}
	routes, err := contextRoutes(deps)
	if err != nil {
		return nil, err
	}
	wrap, err := contextMiddleware(deps)
	if err != nil {
		return nil, err
	}
	grants := application.NewGrantCache(tenancy.Grants{DB: pool}.List, opts.Now)
	sessions := identity.Sessions{DB: pool, Now: opts.Now}
	var headers, web httpx.Middleware
	if opts.WebDir != "" {
		if web, err = httpx.Web(opts.WebDir); err != nil {
			return nil, err
		}
		headers = httpx.SecurityHeaders(httpx.SecurityOptions{HSTS: opts.HSTS})
	}
	return httpx.NewHandler(httpx.Options{
		Logger:       opts.Logger,
		Headers:      headers,
		Web:          web,
		Ready:        readiness(opts.ReadyGate, database.Ping(pool)),
		AllowedHosts: opts.AllowedHosts,
		AccessLog:    opts.AccessLog,
		Metrics:      httpx.NewMetrics(time.Now),
		Auth: append([]httpx.Middleware{
			identityhttp.Session(identityhttp.SessionOptions{
				Sessions:   sessions,
				RequireMFA: opts.RequireMFA,
				Logger:     opts.Logger,
			}),
			// Geography's 100 kB body limit runs before the project scope reads the body, as
			// geographyRequestLimit does in apps/api/src/app.ts.
			geographyhttp.RequestLimit(),
			// The source routes' 8 KiB limit runs at the same point, as sourceRequestLimit does.
			integrationhttp.RequestLimit(),
			// Every other body is bounded here, before the project scope is the first to read it.
			httpx.BodyLimit(httpx.MaxRequestBody, ownBodyLimit),
			tenancyhttp.Middleware(grants, opts.Logger),
			identityhttp.RoleGate(),
		}, wrap...),
		Routes: func(mux *http.ServeMux) {
			mux.HandleFunc("GET /system/auth/current-scope", tenancyhttp.CurrentScope)
			identityhttp.Routes(mux, sessions, opts.GoogleEnabled, opts.Logger)
			for _, register := range routes {
				register(mux)
			}
			if opts.Routes != nil {
				opts.Routes(mux)
			}
		},
	}), nil
}

// readiness asks the gate first: it costs no round trip.
func readiness(gate, ping httpx.ReadyFunc) httpx.ReadyFunc {
	return func(ctx context.Context) error {
		if gate != nil {
			if err := gate(ctx); err != nil {
				return err
			}
		}
		return ping(ctx)
	}
}
