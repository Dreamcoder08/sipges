// Package app composes the Go API's handler: the platform middleware, the identity and tenancy
// gates in the TypeScript API's order (session, project scope, role gate), and the routes.
package app

import (
	"log/slog"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	audithttp "github.com/Dreamcoder08/sipges/apps/api-go/internal/audit/http"
	identityhttp "github.com/Dreamcoder08/sipges/apps/api-go/internal/identity/http"
	identity "github.com/Dreamcoder08/sipges/apps/api-go/internal/identity/infrastructure"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/database"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/httpx"
	prevention "github.com/Dreamcoder08/sipges/apps/api-go/internal/prevention/application"
	preventionhttp "github.com/Dreamcoder08/sipges/apps/api-go/internal/prevention/http"
	preventionsql "github.com/Dreamcoder08/sipges/apps/api-go/internal/prevention/infrastructure"
	situationshttp "github.com/Dreamcoder08/sipges/apps/api-go/internal/situations/http"
	situationssql "github.com/Dreamcoder08/sipges/apps/api-go/internal/situations/infrastructure"
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
	// Routes adds routes beyond the ones registered here (tests).
	Routes func(mux *http.ServeMux)
}

// NewHandler builds the API on pool.
func NewHandler(pool *pgxpool.Pool, opts Options) http.Handler {
	grants := application.NewGrantCache(tenancy.Grants{DB: pool}.List, opts.Now)
	sessions := identity.Sessions{DB: pool, Now: opts.Now}
	return httpx.NewHandler(httpx.Options{
		Logger:       opts.Logger,
		Ready:        database.Ping(pool),
		AllowedHosts: opts.AllowedHosts,
		AccessLog:    opts.AccessLog,
		Auth: []httpx.Middleware{
			identityhttp.Session(identityhttp.SessionOptions{
				Sessions:   sessions,
				RequireMFA: opts.RequireMFA,
				Logger:     opts.Logger,
			}),
			tenancyhttp.Middleware(grants, opts.Logger),
			identityhttp.RoleGate(),
		},
		Routes: func(mux *http.ServeMux) {
			mux.HandleFunc("GET /system/auth/current-scope", tenancyhttp.CurrentScope)
			identityhttp.Routes(mux, sessions, opts.GoogleEnabled, opts.Logger)
			audithttp.Register(mux, audithttp.Deps{Pool: pool, Logger: opts.Logger, Now: opts.Now})
			preventionhttp.Routes(mux, prevention.Service{Store: preventionsql.Actions{DB: pool}, Now: opts.Now}, opts.Logger)
			situationshttp.Routes(mux, situationshttp.Options{DB: pool, Store: situationssql.Store{}, Now: opts.Now, Logger: opts.Logger})
			if opts.Routes != nil {
				opts.Routes(mux)
			}
		},
	})
}
