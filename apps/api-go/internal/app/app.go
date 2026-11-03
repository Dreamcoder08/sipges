// Package app composes the Go API's handler: the platform middleware, the identity and tenancy
// gates in the TypeScript API's order (session, project scope, role gate), and the routes.
package app

import (
	"log/slog"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	identityhttp "github.com/Dreamcoder08/sipges/apps/api-go/internal/identity/http"
	identity "github.com/Dreamcoder08/sipges/apps/api-go/internal/identity/infrastructure"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/database"
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
	// Now is the clock for session expiry and the grant cache; nil means time.Now.
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
			if opts.Routes != nil {
				opts.Routes(mux)
			}
		},
	})
}
