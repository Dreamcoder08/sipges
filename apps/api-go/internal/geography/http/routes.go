package http

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/geography/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/geography/domain"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/geography/infrastructure"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/database"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/httpx"
	tenancyhttp "github.com/Dreamcoder08/sipges/apps/api-go/internal/tenancy/http"
)

// The bodies of the TypeScript API, byte for byte.
const (
	invalidJSON   = "JSON inválido"
	invalidArea   = "Área o capa inválida. Use WGS84 y un máximo de 5° por eje."
	unreachable   = "No fue posible consultar INGEMMET. Intente nuevamente o consulte el visor oficial."
	tooLargeQuery = "Consulta demasiado extensa"
)

// queryPath is the only path RequestLimit limits.
const queryPath = "/system/geography/query"

// maxQueryBytes is geographyRequestLimit's maxSize.
const maxQueryBytes = 100_000

// Deps are what the composition root (internal/app) hands this context. Fields added later must
// work at their zero value.
type Deps struct {
	Pool   *pgxpool.Pool
	Logger *slog.Logger
	// Now is the clock; nil means time.Now.
	Now func() time.Time
	// Gateway replaces INGEMMET (tests); nil means the fixed official gateway.
	Gateway application.Gateway
}

// Register adds the context's routes to mux: GET /system/geography/catalogue and the read-only
// POST /system/geography/query, which computes and persists nothing.
func Register(mux *http.ServeMux, deps Deps) {
	gateway := deps.Gateway
	if gateway == nil {
		gateway = infrastructure.NewGateway(deps.Now)
	}
	var db database.Querier
	if deps.Pool != nil {
		db = deps.Pool
	}
	svc := application.Service{Gateway: gateway, Spatial: infrastructure.NewPostGIS(db, deps.Now, deps.Logger)}

	mux.HandleFunc("GET /system/geography/catalogue", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, svc.Catalogue(r.Context()))
	})
	mux.HandleFunc("POST "+queryPath, func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			writeJSON(w, http.StatusUnprocessableEntity, httpx.ErrorBody{Detail: invalidJSON})
			return
		}
		v, err := domain.DecodeJSON(body)
		if err != nil && !errors.Is(err, domain.ErrTooDeep) {
			writeJSON(w, http.StatusUnprocessableEntity, httpx.ErrorBody{Detail: invalidJSON})
			return
		}
		// JSON.parse reads bodies nested beyond encoding/json; none of them is a valid query.
		q, ok := domain.ParseQuery(v)
		if err != nil || !ok {
			writeJSON(w, http.StatusUnprocessableEntity, httpx.ErrorBody{Detail: invalidArea})
			return
		}
		res, err := svc.Query(r.Context(), q, requestRecords(r, deps.Pool))
		if err != nil {
			if deps.Logger != nil {
				deps.Logger.LogAttrs(r.Context(), slog.LevelWarn, "geography query failed",
					slog.String("request_id", httpx.RequestIDFrom(r.Context())), slog.String("error", err.Error()))
			}
			writeJSON(w, http.StatusBadGateway, httpx.ErrorBody{Detail: unreachable})
			return
		}
		writeJSON(w, http.StatusOK, res)
	})
}

// requestRecords reads the records of the request's project in its tenant transaction, as the
// session's actor with its role's clearance.
func requestRecords(r *http.Request, pool *pgxpool.Pool) application.RecordReader {
	return func(ctx context.Context, modules []string) ([]application.ModuleRecords, error) {
		scope, ok := tenancyhttp.ScopeFrom(ctx)
		if !ok || pool == nil {
			return nil, tenancyhttp.ErrNoScope
		}
		return tenancyhttp.WithRequestTenant(r, pool, func(ctx context.Context, q database.Querier) ([]application.ModuleRecords, error) {
			return infrastructure.ReadRecords(ctx, q, scope.TenantID(), modules)
		})
	}
}

// RequestLimit is geographyRequestLimit (hono/body-limit with maxSize 100 000) on
// /system/geography/query, for any method. It runs after the session check and before the
// project scope reads the body, as in apps/api/src/app.ts.
func RequestLimit() func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path != queryPath || r.Body == nil || r.Body == http.NoBody {
				next.ServeHTTP(w, r)
				return
			}
			if !httpx.WithinBodyLimit(r, maxQueryBytes) {
				writeJSON(w, http.StatusRequestEntityTooLarge, httpx.ErrorBody{Detail: tooLargeQuery})
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// writeJSON is Hono's c.json: the body as JSON.stringify writes it ('<', '>' and '&' unescaped,
// no trailing newline), unlike httpx.WriteJSON.
func writeJSON(w http.ResponseWriter, status int, v any) {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		httpx.WriteError(w, http.StatusInternalServerError, "Internal Server Error")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(bytes.TrimSuffix(b.Bytes(), []byte("\n")))
}
