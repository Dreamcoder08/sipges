// Package http serves the read routes of apps/api/src/contexts/indicators/http/indicators-routes.ts
// with the same JSON: GET /system/irsa, /system/irsa/config, /system/irsa/history,
// /system/indicators, /system/model-status and /system/validation-template. The scope's tenant
// is always used; the session, project scope and role gate ran before (internal/app). The
// engine's answers are sent as the engine wrote them (JSON.stringify's bytes). The writes
// POST /system/irsa/config and POST /system/irsa/snapshot stay in TypeScript.
package http

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/indicators/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/indicators/domain"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/indicators/infrastructure"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/httpx"
	tenancy "github.com/Dreamcoder08/sipges/apps/api-go/internal/tenancy/domain"
	tenancyhttp "github.com/Dreamcoder08/sipges/apps/api-go/internal/tenancy/http"
)

// Deps are what the composition root (internal/app) hands this context.
type Deps struct {
	Pool *pgxpool.Pool
	// Engine is the indicators engine (engines.Set.Indicators).
	Engine application.Engine
	Logger *slog.Logger
}

// Register adds the context's read routes to mux.
func Register(mux *http.ServeMux, deps Deps) {
	Routes(mux, &application.Service{Store: infrastructure.Store{DB: deps.Pool}, Engine: deps.Engine}, deps.Logger)
}

// Routes registers the read routes of service on mux.
func Routes(mux *http.ServeMux, service *application.Service, log *slog.Logger) {
	mux.HandleFunc("GET /system/irsa", handle(log, func(ctx context.Context, scope tenancy.Scope) (any, error) {
		return service.Irsa(ctx, scope.TenantID())
	}))
	mux.HandleFunc("GET /system/irsa/config", handle(log, func(ctx context.Context, scope tenancy.Scope) (any, error) {
		return service.Config(ctx, scope.TenantID())
	}))
	mux.HandleFunc("GET /system/indicators", handle(log, func(ctx context.Context, scope tenancy.Scope) (any, error) {
		return service.Indicators(ctx, scope.TenantID())
	}))
	mux.HandleFunc("GET /system/model-status", handle(log, func(context.Context, tenancy.Scope) (any, error) {
		return json.RawMessage(domain.ModelStatus), nil
	}))
	mux.HandleFunc("GET /system/validation-template", handle(log, func(ctx context.Context, _ tenancy.Scope) (any, error) {
		return service.ValidationTemplate(ctx)
	}))
	mux.HandleFunc("GET /system/irsa/history", func(w http.ResponseWriter, r *http.Request) {
		// Hono's c.req.query reads the first value; a key without "=" reads as "".
		values, present := r.URL.Query()["limit"]
		raw := ""
		if present {
			raw = values[0]
		}
		limit, ok := domain.HistoryLimit(raw, present)
		if !ok {
			httpx.WriteJSON(w, http.StatusUnprocessableEntity, domain.HistoryLimitError)
			return
		}
		handle(log, func(ctx context.Context, scope tenancy.Scope) (any, error) {
			return service.History(ctx, scope.TenantID(), limit)
		})(w, r)
	})
}

// handle answers 200 with the work's JSON, or the TypeScript API's onError 500 when the request
// has no resolved project or the work fails. A json.RawMessage is sent byte for byte.
func handle(log *slog.Logger, work func(context.Context, tenancy.Scope) (any, error)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		scope, ok := tenancyhttp.ScopeFrom(r.Context())
		var (
			body any
			err  = tenancyhttp.ErrNoScope
		)
		if ok {
			body, err = work(r.Context(), scope)
		}
		var raw []byte
		if err == nil {
			if b, isRaw := body.(json.RawMessage); isRaw {
				raw = b
			} else {
				raw, err = domain.Encode(body)
			}
		}
		if err != nil {
			// Only the event: driver and engine errors may carry connection details or data.
			if log != nil {
				log.LogAttrs(r.Context(), slog.LevelError, "indicators read failed",
					slog.String("request_id", httpx.RequestIDFrom(r.Context())))
			}
			httpx.WriteError(w, http.StatusInternalServerError, "Internal Server Error")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(raw) // the status is already sent; a failed write has no recovery
	}
}
