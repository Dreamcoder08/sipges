// Package http serves the JSON routes of apps/api/src/contexts/analytics/http/analytics-routes.ts
// with the same answers: GET /api/dashboard, /system/situational-analysis,
// /system/strategic-assessment, /system/consensus-engine and /system/integrated-analysis. The
// scope's project is always used; the session, project scope (which refuses a `project_id` of
// another project) and role gate ran before (internal/app). The .docx reports are alongside;
// /system/conflict-risk stays in TypeScript.
package http

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/analytics/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/analytics/domain"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/analytics/infrastructure"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/httpx"
	tenancy "github.com/Dreamcoder08/sipges/apps/api-go/internal/tenancy/domain"
	tenancyhttp "github.com/Dreamcoder08/sipges/apps/api-go/internal/tenancy/http"
)

// Deps are what the composition root (internal/app) hands this context. Fields added later must
// work at their zero value.
type Deps struct {
	Pool *pgxpool.Pool
	// Engine runs the analytics WebAssembly module (engines.Set.Analytics).
	Engine application.Engine
	// Renderer writes the Word reports.
	Renderer application.ReportRenderer
	Logger   *slog.Logger
	// Now is the clock of generated_at; nil means time.Now.
	Now func() time.Time
}

// Register adds the context's routes to mux, reading through the SQL readers.
func Register(mux *http.ServeMux, deps Deps) {
	Routes(mux, application.Service{
		Records:  infrastructure.Records{DB: deps.Pool},
		Labels:   infrastructure.Labels{DB: deps.Pool},
		Engine:   deps.Engine,
		Renderer: deps.Renderer,
		Now:      deps.Now,
	}, deps.Logger)
}

// Routes registers the analytics JSON routes on mux.
func Routes(mux *http.ServeMux, service application.Service, log *slog.Logger) {
	mux.HandleFunc("GET /api/dashboard", handle(log, func(ctx context.Context, scope tenancy.Scope) ([]byte, error) {
		summary, err := service.Dashboard(ctx, scope)
		if err != nil {
			return nil, err
		}
		return marshal(summary)
	}))
	for path, analysis := range map[string]func(context.Context, tenancy.Scope) (json.RawMessage, error){
		"/system/situational-analysis": service.Situational,
		"/system/strategic-assessment": service.Strategic,
		"/system/consensus-engine":     service.Consensus,
		"/system/integrated-analysis":  service.Integrated,
	} {
		mux.HandleFunc("GET "+path, handle(log, func(ctx context.Context, scope tenancy.Scope) ([]byte, error) {
			return analysis(ctx, scope)
		}))
	}
	for path, kind := range map[string]domain.ReportKind{
		"/system/situational-report.docx":  domain.ReportSituational,
		"/system/strategic-report.docx":    domain.ReportStrategic,
		"/system/integrated-analysis.docx": domain.ReportIntegrated,
		"/system/consensus-engine.docx":    domain.ReportConsensus,
	} {
		mux.HandleFunc("GET "+path, report(log, service, kind))
	}
}

// report answers one Word report as an attachment; a failure is the same 500 as handle's.
func report(log *slog.Logger, service application.Service, kind domain.ReportKind) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		scope, ok := tenancyhttp.ScopeFrom(r.Context())
		var (
			out application.RenderedReport
			err = tenancyhttp.ErrNoScope
		)
		if ok {
			out, err = service.Report(r.Context(), kind, scope)
		}
		if err != nil {
			if log != nil {
				log.LogAttrs(r.Context(), slog.LevelError, "analytics report failed",
					slog.String("request_id", httpx.RequestIDFrom(r.Context())))
			}
			httpx.WriteError(w, http.StatusInternalServerError, "Internal Server Error")
			return
		}
		w.Header().Set("Content-Type", out.ContentType)
		w.Header().Set("Content-Disposition", `attachment; filename="`+out.FileName+`"`)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(out.Bytes)
	}
}

// marshal is JSON.stringify's spelling where encoding/json differs: '<', '>' and '&' unescaped.
func marshal(v any) ([]byte, error) {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return bytes.TrimSuffix(b.Bytes(), []byte("\n")), nil
}

// handle answers 200 with the work's JSON bytes as they are (the engines' answer is
// JSON.stringify of the TypeScript result, as c.json sends it), or the TypeScript API's onError
// 500 when the request has no resolved project or the work fails.
func handle(log *slog.Logger, work func(context.Context, tenancy.Scope) ([]byte, error)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		scope, ok := tenancyhttp.ScopeFrom(r.Context())
		var (
			body []byte
			err  = tenancyhttp.ErrNoScope
		)
		if ok {
			body, err = work(r.Context(), scope)
		}
		if err != nil {
			// Only the event: driver and engine errors may carry connection or record details.
			if log != nil {
				log.LogAttrs(r.Context(), slog.LevelError, "analytics read failed",
					slog.String("request_id", httpx.RequestIDFrom(r.Context())))
			}
			httpx.WriteError(w, http.StatusInternalServerError, "Internal Server Error")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(body) // the status is already sent; a failed write has no recovery
	}
}
