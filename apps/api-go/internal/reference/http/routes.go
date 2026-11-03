// Package http serves the reference routes of apps/api/src/contexts/reference/http. It reads
// the request's project through a function, so the context depends on no other context; the
// composition root passes the tenancy middleware's accessor.
package http

import (
	"context"
	"log/slog"
	"net/http"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/httpx"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/reference/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/reference/domain"
)

// ScopeFunc returns the project the request was resolved to.
type ScopeFunc func(ctx context.Context) (domain.Scope, bool)

// Register adds GET /system/project-coordinates and GET /system/canonical-entities to mux.
// They must sit behind the session and tenancy middleware, as in the TypeScript API.
func Register(mux *http.ServeMux, svc *application.Service, scope ScopeFunc, log *slog.Logger) {
	mux.HandleFunc("GET /system/project-coordinates", func(w http.ResponseWriter, r *http.Request) {
		s, ok := scope(r.Context())
		if !ok {
			fail(w, r, log, "no project scope")
			return
		}
		body, err := svc.Coordinates(r.Context(), s)
		if err != nil {
			fail(w, r, log, err.Error())
			return
		}
		httpx.WriteJSON(w, http.StatusOK, body)
	})
	mux.HandleFunc("GET /system/canonical-entities", func(w http.ResponseWriter, r *http.Request) {
		s, ok := scope(r.Context())
		if !ok {
			fail(w, r, log, "no project scope")
			return
		}
		body, err := svc.Entities(r.Context(), s)
		if err != nil {
			fail(w, r, log, err.Error())
			return
		}
		httpx.WriteJSON(w, http.StatusOK, body)
	})
}

// fail is the TypeScript API's onError: log the cause, answer the generic 500.
func fail(w http.ResponseWriter, r *http.Request, log *slog.Logger, cause string) {
	log.LogAttrs(r.Context(), slog.LevelError, "unhandled_error",
		slog.String("request_id", httpx.RequestIDFrom(r.Context())),
		slog.String("method", r.Method),
		slog.String("path", r.URL.Path),
		slog.String("error", cause))
	httpx.WriteError(w, http.StatusInternalServerError, "Internal Server Error")
}
