// Package app composes the Go API's handler: the platform middleware, the identity and tenancy
// gates in the TypeScript API's order (session, project scope, role gate), and the routes.
package app

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	audithttp "github.com/Dreamcoder08/sipges/apps/api-go/internal/audit/http"
	identityhttp "github.com/Dreamcoder08/sipges/apps/api-go/internal/identity/http"
	identity "github.com/Dreamcoder08/sipges/apps/api-go/internal/identity/infrastructure"
	indicatorshttp "github.com/Dreamcoder08/sipges/apps/api-go/internal/indicators/http"
	managementhttp "github.com/Dreamcoder08/sipges/apps/api-go/internal/management/http"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/database"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/engines"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/httpx"
	prevention "github.com/Dreamcoder08/sipges/apps/api-go/internal/prevention/application"
	preventionhttp "github.com/Dreamcoder08/sipges/apps/api-go/internal/prevention/http"
	preventionsql "github.com/Dreamcoder08/sipges/apps/api-go/internal/prevention/infrastructure"
	referenceapp "github.com/Dreamcoder08/sipges/apps/api-go/internal/reference/application"
	referencedomain "github.com/Dreamcoder08/sipges/apps/api-go/internal/reference/domain"
	referencehttp "github.com/Dreamcoder08/sipges/apps/api-go/internal/reference/http"
	reference "github.com/Dreamcoder08/sipges/apps/api-go/internal/reference/infrastructure"
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
	// Engines are the compiled Rust engines; nil means engines.Shared.
	Engines *engines.Set
	// Routes adds routes beyond the ones registered here (tests).
	Routes func(mux *http.ServeMux)
}

// NewHandler builds the API on pool. It fails only when the embedded reference files do not
// match their contract.
func NewHandler(pool *pgxpool.Pool, opts Options) (http.Handler, error) {
	references, err := reference.NewEmbeddedReader()
	if err != nil {
		return nil, fmt.Errorf("reference: %w", err)
	}
	referenceService := referenceapp.NewService(references)
	grants := application.NewGrantCache(tenancy.Grants{DB: pool}.List, opts.Now)
	sessions := identity.Sessions{DB: pool, Now: opts.Now}
	if opts.Engines == nil {
		compiled, err := engines.Shared(context.Background())
		if err != nil {
			return nil, err
		}
		opts.Engines = compiled
	}
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
			indicatorshttp.Register(mux, indicatorshttp.Deps{Pool: pool, Engine: opts.Engines.Indicators, Logger: opts.Logger})
			preventionhttp.Routes(mux, prevention.Service{Store: preventionsql.Actions{DB: pool}, Now: opts.Now}, opts.Logger)
			situationshttp.Routes(mux, situationshttp.Options{DB: pool, Store: situationssql.Store{}, Now: opts.Now, Logger: opts.Logger})
			referencehttp.Register(mux, referenceService, referenceScope, opts.Logger)
			managementhttp.Register(mux, managementhttp.Deps{Pool: pool, Logger: opts.Logger, Now: opts.Now})
			if opts.Routes != nil {
				opts.Routes(mux)
			}
		},
	}), nil
}

// referenceScope hands the tenancy middleware's project to the reference context.
func referenceScope(ctx context.Context) (referencedomain.Scope, bool) {
	s, ok := tenancyhttp.ScopeFrom(ctx)
	return referencedomain.Scope{CompanyID: s.CompanyID, ProjectID: s.ProjectID}, ok
}
