// Package http serves the audit context's routes (apps/api/src/contexts/audit/http).
package http

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/audit/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/audit/infrastructure"
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
	// ActivityPoll, ActivityMax and ActivityHeartbeat override the live activity stream's
	// timings (ActivityOptions of activity-routes.ts); zero keeps the default.
	ActivityPoll      time.Duration
	ActivityMax       time.Duration
	ActivityHeartbeat time.Duration
}

// Register adds the context's routes to mux.
func Register(mux *http.ServeMux, deps Deps) {
	t := sqlTrail{db: deps.Pool}
	mux.HandleFunc("GET /system/audit", auditHandler(t, deps.Logger))
	mux.HandleFunc("GET "+ActivityPath, activityHandler(t, deps.activityOptions(), deps.Logger))
}

// trail reads the audit trail of the request's resolved project.
type trail interface {
	Latest(r *http.Request, limit int) ([]application.Record, error)
	After(r *http.Request, afterID int64, limit int) ([]application.Record, error)
	LastID(r *http.Request) (int64, error)
}

// sqlTrail is createSqlAuditReader: each read is one tenant transaction of the request.
type sqlTrail struct{ db database.Beginner }

func (s sqlTrail) Latest(r *http.Request, limit int) ([]application.Record, error) {
	return tenancyhttp.WithRequestTenant(r, s.db, func(ctx context.Context, q database.Querier) ([]application.Record, error) {
		return infrastructure.Latest(ctx, q, limit)
	})
}

func (s sqlTrail) After(r *http.Request, afterID int64, limit int) ([]application.Record, error) {
	return tenancyhttp.WithRequestTenant(r, s.db, func(ctx context.Context, q database.Querier) ([]application.Record, error) {
		return infrastructure.After(ctx, q, afterID, limit)
	})
}

func (s sqlTrail) LastID(r *http.Request) (int64, error) {
	return tenancyhttp.WithRequestTenant(r, s.db, infrastructure.LastID)
}

// auditEntry is AuditEntry of @sipges/contracts.
type auditEntry struct {
	ID       int64   `json:"id"`
	TS       string  `json:"ts"`
	Module   string  `json:"module"`
	RecordID *string `json:"record_id"`
	Action   string  `json:"action"`
	Detail   *string `json:"detail"`
}

// auditHandler is audit-routes.ts, GET /system/audit (app.py audit): admin-only through the
// role gate (identity/domain/access.go), newest first, active project only.
func auditHandler(t trail, log *slog.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		limit, ok := parseIntQuery(w, r, "limit", 100)
		if !ok {
			return
		}
		records, err := t.Latest(r, application.LatestLimit(limit))
		if err != nil {
			internalError(w, r, log, "audit read failed", err)
			return
		}
		out := make([]auditEntry, 0, len(records))
		for _, rec := range records {
			out = append(out, auditEntry{ID: rec.ID, TS: isoSeconds(rec.At), Module: rec.Module,
				RecordID: rec.RecordID, Action: rec.Action, Detail: rec.Detail})
		}
		writeJSON(w, http.StatusOK, out)
	}
}

func internalError(w http.ResponseWriter, r *http.Request, log *slog.Logger, msg string, err error) {
	if log != nil {
		log.LogAttrs(r.Context(), slog.LevelError, msg, slog.String("error", err.Error()),
			slog.String("request_id", httpx.RequestIDFrom(r.Context())))
	}
	httpx.WriteError(w, http.StatusInternalServerError, "Internal Server Error")
}

// marshal is JSON.stringify for the values here: '<', '>' and '&' stay as they are.
func marshal(v any) ([]byte, error) {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return bytes.TrimSuffix(b.Bytes(), []byte("\n")), nil
}

// writeJSON is Hono's c.json: the body as JSON.stringify writes it, without a trailing newline.
func writeJSON(w http.ResponseWriter, status int, v any) {
	body, err := marshal(v)
	if err != nil {
		httpx.WriteError(w, http.StatusInternalServerError, "Internal Server Error")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(body)
}

// validationIssue is ValidationIssue of apps/api/src/platform/http/validation.ts.
type validationIssue struct {
	Type string `json:"type"`
	Loc  []any  `json:"loc"`
	Msg  string `json:"msg"`
}

// parseIntQuery is parseIntQuery of apps/api/src/platform/http/validation.ts (FastAPI
// `limit: int = N`): the fallback when the parameter is absent, a 422 when it does not match
// /^\s*[+-]?\d+\s*$/, else its value, saturated at the int64 bounds (JavaScript reads larger
// ones as huge or infinite numbers, which every caller clamps the same way).
func parseIntQuery(w http.ResponseWriter, r *http.Request, name string, fallback int64) (int64, bool) {
	raw, present := httpx.QueryParam(r, name)
	if !present {
		return fallback, true
	}
	if value, ok := parseJSInt(strings.TrimFunc(raw, isJSSpace)); ok {
		return value, true
	}
	writeJSON(w, http.StatusUnprocessableEntity, httpx.ErrorBody{Detail: []validationIssue{{
		Type: "int_parsing",
		Loc:  []any{"query", name},
		Msg:  "Input should be a valid integer, unable to parse string as an integer",
	}}})
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

// isJSSpace is JavaScript's \s (WhiteSpace and LineTerminator), which also bounds Number().
func isJSSpace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', 0x00a0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff:
		return true
	}
	return r >= 0x2000 && r <= 0x200a
}

// isoSeconds is isoSeconds of apps/api/src/platform/http/time.ts: Date.toISOString without the
// fractional seconds, including its six-digit signed years outside 0000-9999.
func isoSeconds(t time.Time) string {
	t = t.UTC()
	year := fmt.Sprintf("%04d", t.Year())
	if t.Year() < 0 || t.Year() > 9999 {
		year = fmt.Sprintf("%+07d", t.Year())
	}
	return year + t.Format("-01-02T15:04:05") + "Z"
}
