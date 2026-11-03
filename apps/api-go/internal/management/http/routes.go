// Package http serves the management context's routes, the Go port of
// apps/api/src/contexts/management/http/management-routes.ts: the management center
// (app.py:2260-2270) for the active scope's project.
package http

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/management/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/management/domain"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/management/infrastructure"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/database"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/httpx"
	tenancyhttp "github.com/Dreamcoder08/sipges/apps/api-go/internal/tenancy/http"
)

// Deps are what the composition root (internal/app) hands this context. Fields added later must
// work at their zero value.
type Deps struct {
	Pool   *pgxpool.Pool
	Logger *slog.Logger
	// Now is the clock; nil means time.Now.
	Now func() time.Time
}

// Register adds GET /system/management/overview and GET /system/management/report.csv.
func Register(mux *http.ServeMux, deps Deps) {
	now := deps.Now
	if now == nil {
		now = time.Now
	}
	// read returns the scope's project, the clock reading and the sources, all for one request.
	read := func(w http.ResponseWriter, r *http.Request) (string, time.Time, application.Snapshot, bool) {
		at := now()
		scope, _ := tenancyhttp.ScopeFrom(r.Context())
		snapshot, err := tenancyhttp.WithRequestTenant(r, deps.Pool,
			func(ctx context.Context, q database.Querier) (application.Snapshot, error) {
				return infrastructure.Read(ctx, q, scope.TenantID(), scope.ProjectID)
			})
		if err != nil {
			if deps.Logger != nil {
				deps.Logger.LogAttrs(r.Context(), slog.LevelError, "management read failed",
					slog.String("request_id", httpx.RequestIDFrom(r.Context())), slog.String("error", err.Error()))
			}
			httpx.WriteError(w, http.StatusInternalServerError, "Internal Server Error")
			return "", at, snapshot, false
		}
		return scope.ProjectID, at, snapshot, true
	}

	mux.HandleFunc("GET /system/management/overview", func(w http.ResponseWriter, r *http.Request) {
		if project, at, snapshot, ok := read(w, r); ok {
			writeJSON(w, application.Overview(project, at, snapshot))
		}
	})
	mux.HandleFunc("GET /system/management/report.csv", func(w http.ResponseWriter, r *http.Request) {
		if project, at, snapshot, ok := read(w, r); ok {
			w.Header().Set("Content-Type", "text/csv; charset=utf-8")
			w.Header().Set("Content-Disposition", `attachment; filename="`+domain.ManagementCSVFilename+`"`)
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(application.CSV(project, at, snapshot)))
		}
	})
}

// writeJSON is Hono's c.json with status 200: the body as JSON.stringify writes it ('<', '>' and
// '&' unescaped, no trailing newline), unlike httpx.WriteJSON.
func writeJSON(w http.ResponseWriter, v any) {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		httpx.WriteError(w, http.StatusInternalServerError, "Internal Server Error")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(bytes.TrimSuffix(b.Bytes(), []byte("\n")))
}
