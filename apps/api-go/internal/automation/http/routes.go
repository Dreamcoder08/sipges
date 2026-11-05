// Package http serves the read routes of apps/api/src/contexts/automation/http/automation-routes.ts
// with the same JSON: GET /system/automations (rules, channels and latest runs, admin-only through
// the role gate), GET /system/automations/runs and the inbox, GET /system/notifications (every
// role, as its own user). The session, project scope and role gate ran before (internal/app).
//
// writes.go adds the rule and channel writes, marking notifications read, the project's tick and
// the cron; push.go adds one's own device notifications; wakeup.go wakes the runtime after
// business writes. GET /system/automations/runtime stays in TypeScript.
package http

import (
	"context"
	"errors"
	"log/slog"
	"math"
	"net/http"
	"strconv"
	"strings"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/automation/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/automation/domain"
	identityhttp "github.com/Dreamcoder08/sipges/apps/api-go/internal/identity/http"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/database"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/httpx"
	tenancyhttp "github.com/Dreamcoder08/sipges/apps/api-go/internal/tenancy/http"
)

// Options configures Routes.
type Options struct {
	DB     database.Beginner
	Store  application.Store
	Logger *slog.Logger
}

// errNoPrincipal is unreachable behind the session gate; the route refuses rather than read an
// inbox for nobody.
var errNoPrincipal = errors.New("automation: the request has no session")

// Routes registers the automation read routes on mux.
func Routes(mux *http.ServeMux, opts Options) {
	mux.HandleFunc("GET /system/automations", func(w http.ResponseWriter, r *http.Request) {
		out, err := tenancyhttp.WithRequestTenant(r, opts.DB, func(ctx context.Context, q database.Querier) (application.OverviewJSON, error) {
			rules, err := opts.Store.Rules(ctx, q)
			if err != nil {
				return application.OverviewJSON{}, err
			}
			channels, err := opts.Store.Channels(ctx, q)
			if err != nil {
				return application.OverviewJSON{}, err
			}
			runs, err := opts.Store.Runs(ctx, q, application.OverviewRuns)
			if err != nil {
				return application.OverviewJSON{}, err
			}
			return application.Overview(rules, channels, runs)
		})
		respond(w, r, opts.Logger, out, err)
	})

	mux.HandleFunc("GET /system/automations/runs", func(w http.ResponseWriter, r *http.Request) {
		limit, ok := parseIntQuery(w, r, "limit", 50)
		if !ok {
			return
		}
		out, err := tenancyhttp.WithRequestTenant(r, opts.DB, func(ctx context.Context, q database.Querier) ([]application.RunJSON, error) {
			runs, err := opts.Store.Runs(ctx, q, domain.RunsLimit(limit))
			if err != nil {
				return nil, err
			}
			return application.RunsOut(runs)
		})
		respond(w, r, opts.Logger, out, err)
	})

	mux.HandleFunc("GET /system/notifications", func(w http.ResponseWriter, r *http.Request) {
		limit, ok := parseIntQuery(w, r, "limit", 30)
		if !ok {
			return
		}
		principal, signedIn := identityhttp.PrincipalFrom(r.Context())
		if !signedIn || principal == nil {
			respond(w, r, opts.Logger, nil, errNoPrincipal)
			return
		}
		out, err := tenancyhttp.WithRequestTenant(r, opts.DB, func(ctx context.Context, q database.Querier) (application.InboxJSON, error) {
			inbox, err := opts.Store.Inbox(ctx, q, principal.Username, domain.InboxLimit(limit))
			return application.InboxOut(inbox), err
		})
		respond(w, r, opts.Logger, out, err)
	})
}

// respond writes body as Hono's c.json, or the TypeScript API's onError 500 when the read
// failed.
func respond(w http.ResponseWriter, r *http.Request, log *slog.Logger, body any, err error) {
	var b []byte
	if err == nil {
		b, err = application.Marshal(body)
	}
	if err != nil {
		// Only the event: driver errors may carry connection details.
		if log != nil {
			log.LogAttrs(r.Context(), slog.LevelError, "automation read failed",
				slog.String("request_id", httpx.RequestIDFrom(r.Context())))
		}
		httpx.WriteError(w, http.StatusInternalServerError, "Internal Server Error")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(b) //nolint:gosec // G705: JSON served as application/json, never read as HTML
}

// validationIssue is ValidationIssue of apps/api/src/platform/http/validation.ts.
type validationIssue struct {
	Type string `json:"type"`
	Loc  []any  `json:"loc"`
	Msg  string `json:"msg"`
}

// parseIntQuery is parseIntQuery of apps/api/src/platform/http/validation.ts (FastAPI
// `limit: int = N`), as internal/audit/http reads it: the fallback when the parameter is
// absent, a 422 when it does not match /^\s*[+-]?\d+\s*$/, else its value saturated at the
// int64 bounds (every caller clamps it the same way JavaScript does).
func parseIntQuery(w http.ResponseWriter, r *http.Request, name string, fallback int64) (int64, bool) {
	raw, present := httpx.QueryParam(r, name)
	if !present {
		return fallback, true
	}
	if value, ok := parseJSInt(strings.TrimFunc(raw, isJSSpace)); ok {
		return value, true
	}
	b, _ := application.Marshal(httpx.ErrorBody{Detail: []validationIssue{{
		Type: "int_parsing",
		Loc:  []any{"query", name},
		Msg:  "Input should be a valid integer, unable to parse string as an integer",
	}}})
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusUnprocessableEntity)
	_, _ = w.Write(b)
	return 0, false
}

// parseJSInt reads [+-]?\d+ with ASCII digits only, as JavaScript's \d.
func parseJSInt(s string) (int64, bool) {
	digits := strings.TrimLeft(s, "+-")
	if len(s)-len(digits) > 1 || digits == "" || strings.Trim(digits, "0123456789") != "" {
		return 0, false
	}
	v, err := strconv.ParseInt(s, 10, 64)
	if errors.Is(err, strconv.ErrRange) {
		if strings.HasPrefix(s, "-") {
			return math.MinInt64, true
		}
		return math.MaxInt64, true
	}
	return v, err == nil
}

// isJSSpace is JavaScript's \s (WhiteSpace and LineTerminator).
func isJSSpace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', 0x00a0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff:
		return true
	}
	return r >= 0x2000 && r <= 0x200a
}
