// Package http serves apps/api/src/contexts/situations/http/situations-routes.ts with the same JSON:
// GET and PUT /system/v4/settings and GET /system/v4/situations. The session, project scope and role
// gate (admin-only for PUT) ran before (internal/app); all of it runs in the scope's tenant
// transaction.
package http

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"time"

	identityhttp "github.com/Dreamcoder08/sipges/apps/api-go/internal/identity/http"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/database"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/httpx"
	records "github.com/Dreamcoder08/sipges/apps/api-go/internal/records/domain"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/situations/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/situations/domain"
	tenancyhttp "github.com/Dreamcoder08/sipges/apps/api-go/internal/tenancy/http"
)

// Options configures Routes.
type Options struct {
	DB    database.Beginner
	Store application.Store
	// Now is the clock for "today" and generated_at; nil means time.Now.
	Now    func() time.Time
	Logger *slog.Logger
}

type snapshot struct {
	stored  *domain.Stored
	records []domain.SourceRecord
}

// Routes registers the situations' routes on mux.
func Routes(mux *http.ServeMux, opts Options) {
	now := opts.Now
	if now == nil {
		now = time.Now
	}
	fail := func(w http.ResponseWriter, r *http.Request) {
		// Only the event: driver errors may carry connection details.
		if opts.Logger != nil {
			opts.Logger.LogAttrs(r.Context(), slog.LevelError, "situations request failed",
				slog.String("request_id", httpx.RequestIDFrom(r.Context())))
		}
		httpx.WriteError(w, http.StatusInternalServerError, "Internal Server Error")
	}

	mux.HandleFunc("GET /system/v4/settings", func(w http.ResponseWriter, r *http.Request) {
		stored, err := tenancyhttp.WithRequestTenant(r, opts.DB, func(ctx context.Context, q database.Querier) (*domain.Stored, error) {
			return opts.Store.Settings(ctx, q, tenantOf(r))
		})
		if err != nil {
			fail(w, r)
			return
		}
		httpx.WriteJSON(w, http.StatusOK, application.Settings(stored))
	})

	mux.HandleFunc("PUT /system/v4/settings", func(w http.ResponseWriter, r *http.Request) {
		patch, ok := settingsPatch(w, r)
		if !ok {
			return
		}
		principal, ok := identityhttp.PrincipalFrom(r.Context())
		if !ok {
			fail(w, r)
			return
		}
		at := now().Truncate(time.Millisecond)
		saved, err := tenancyhttp.WithRequestTenant(r, opts.DB, func(ctx context.Context, q database.Querier) (application.SettingsJSON, error) {
			return application.UpdateSettings(ctx, q, opts.Store, tenantOf(r), patch, principal.Username, at)
		})
		if err != nil {
			fail(w, r)
			return
		}
		httpx.WriteJSONText(w, http.StatusOK, saved)
	})

	mux.HandleFunc("GET /system/v4/situations", func(w http.ResponseWriter, r *http.Request) {
		// One transaction for both reads, where TypeScript opens two: same rows, one round trip less.
		snap, err := tenancyhttp.WithRequestTenant(r, opts.DB, func(ctx context.Context, q database.Querier) (snapshot, error) {
			tenant := tenantOf(r)
			stored, err := opts.Store.Settings(ctx, q, tenant)
			if err != nil {
				return snapshot{}, err
			}
			records, err := opts.Store.Records(ctx, q, tenant, domain.Modules)
			return snapshot{stored, records}, err
		})
		if err != nil {
			fail(w, r)
			return
		}
		httpx.WriteJSON(w, http.StatusOK, application.Situations(snap.stored, snap.records, now()))
	})
}

// settingsPatch is parseJson(c, ProjectSettingsIn): the patch, or the 422 that refused the body.
func settingsPatch(w http.ResponseWriter, r *http.Request) (domain.SettingsPatch, bool) {
	var patch domain.SettingsPatch
	issues := records.JSONInvalid
	if data, err := io.ReadAll(r.Body); err == nil {
		var body any
		if body, err = records.ParseBody(data); err == nil {
			patch, issues = domain.ParseSettingsPatch(body)
		}
	}
	if issues == nil {
		return patch, true
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusUnprocessableEntity)
	_, _ = w.Write(records.AppendIssues(nil, issues)) // the status is already sent
	return patch, false
}

// tenantOf is formatScope of the request's resolved project; WithRequestTenant already refused a
// request without one.
func tenantOf(r *http.Request) string {
	scope, _ := tenancyhttp.ScopeFrom(r.Context())
	return scope.TenantID()
}
