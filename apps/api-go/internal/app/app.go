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

	identityhttp "github.com/Dreamcoder08/sipges/apps/api-go/internal/identity/http"
	identity "github.com/Dreamcoder08/sipges/apps/api-go/internal/identity/infrastructure"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/database"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/httpx"
	referenceapp "github.com/Dreamcoder08/sipges/apps/api-go/internal/reference/application"
	referencedomain "github.com/Dreamcoder08/sipges/apps/api-go/internal/reference/domain"
	referencehttp "github.com/Dreamcoder08/sipges/apps/api-go/internal/reference/http"
	reference "github.com/Dreamcoder08/sipges/apps/api-go/internal/reference/infrastructure"
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
	// Now is the clock for session expiry and the grant cache; nil means time.Now.
	Now func() time.Time
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
	return httpx.NewHandler(httpx.Options{
		Logger:       opts.Logger,
		Ready:        database.Ping(pool),
		AllowedHosts: opts.AllowedHosts,
		AccessLog:    opts.AccessLog,
		Auth: []httpx.Middleware{
			identityhttp.Session(identityhttp.SessionOptions{
				Sessions:   identity.Sessions{DB: pool, Now: opts.Now},
				RequireMFA: opts.RequireMFA,
				Logger:     opts.Logger,
			}),
			tenancyhttp.Middleware(grants, opts.Logger),
			identityhttp.RoleGate(),
		},
		Routes: func(mux *http.ServeMux) {
			mux.HandleFunc("GET /system/auth/current-scope", tenancyhttp.CurrentScope)
			referencehttp.Register(mux, referenceService, referenceScope, opts.Logger)
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
