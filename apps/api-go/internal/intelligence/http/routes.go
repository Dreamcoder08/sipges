// Package http serves the read routes of
// apps/api/src/contexts/intelligence/http/intelligence-routes.ts with the same JSON:
// GET /system/intelligence/territorial-alerts, /territorial-alerts/{id} and
// /territorial-summary. The scope's project is always used; the session, project scope and role
// gate ran before (internal/app).
package http

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/intelligence/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/intelligence/domain"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/httpx"
	tenancy "github.com/Dreamcoder08/sipges/apps/api-go/internal/tenancy/domain"
	tenancyhttp "github.com/Dreamcoder08/sipges/apps/api-go/internal/tenancy/http"
)

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

// alertJSON is alertJSON of intelligence-routes.ts, in its key order.
type alertJSON struct {
	ID             string          `json:"id"`
	ProjectID      string          `json:"project_id"`
	CreatedAt      string          `json:"created_at"`
	SourceURL      string          `json:"source_url"`
	SourceType     string          `json:"source_type"`
	Territory      *string         `json:"territory"`
	SourceRecord   json.RawMessage `json:"source_record"`
	Excerpt        string          `json:"excerpt"`
	SHA256         string          `json:"sha256"`
	Level          string          `json:"level"`
	Score          int             `json:"score"`
	Method         string          `json:"method"`
	SemanticActive bool            `json:"semantic_active"`
	Status         string          `json:"status"`
	AnalystNote    string          `json:"analyst_note"`
	ReviewerNote   *string         `json:"reviewer_note"`
	ReviewedAt     *string         `json:"reviewed_at"`
	FirstValidator *string         `json:"first_validator"`
	Themes         json.RawMessage `json:"themes"`
	Signals        json.RawMessage `json:"signals"`
	Suggestions    json.RawMessage `json:"suggestions"`
}

var jsonNull = json.RawMessage("null")

func toAlertJSON(a domain.Alert) alertJSON {
	out := alertJSON{
		ID: a.ID, ProjectID: a.ProjectID, CreatedAt: isoSeconds(a.CreatedAt), SourceURL: a.SourceURL,
		SourceType: a.SourceType, Territory: a.Territory, SourceRecord: a.SourceRecord, Excerpt: a.Excerpt,
		SHA256: a.SHA256, Level: a.Level, Score: a.Score, Method: a.Method, SemanticActive: a.SemanticActive,
		Status: a.Status, AnalystNote: a.AnalystNote, ReviewerNote: a.ReviewerNote,
		FirstValidator: a.FirstValidator, Themes: a.Themes, Signals: a.Signals, Suggestions: a.Suggestions,
	}
	if out.SourceRecord == nil {
		out.SourceRecord = jsonNull
	}
	if a.ReviewedAt != nil {
		at := isoSeconds(*a.ReviewedAt)
		out.ReviewedAt = &at
	}
	return out
}

// Routes registers the intelligence read routes on mux.
func Routes(mux *http.ServeMux, service application.Service, log *slog.Logger) {
	const prefix = "GET /system/intelligence/"
	mux.HandleFunc(prefix+"territorial-alerts", func(w http.ResponseWriter, r *http.Request) {
		limit, ok := httpx.IntQuery(w, r, "limit", 50)
		if !ok {
			return
		}
		respond(w, r, log, func(scope tenancy.Scope) (int, any, error) {
			alerts, err := service.ListAlerts(r.Context(), scope, limit)
			out := make([]alertJSON, 0, len(alerts))
			for _, a := range alerts {
				out = append(out, toAlertJSON(a))
			}
			return http.StatusOK, out, err
		})
	})
	mux.HandleFunc(prefix+"territorial-alerts/{id}", func(w http.ResponseWriter, r *http.Request) {
		respond(w, r, log, func(scope tenancy.Scope) (int, any, error) {
			alert, err := service.GetAlert(r.Context(), scope, httpx.PathParam(r, "id"))
			if err != nil || alert == nil {
				return http.StatusNotFound, httpx.ErrorBody{Detail: "Evaluación no encontrada"}, err
			}
			return http.StatusOK, toAlertJSON(*alert), nil
		})
	})
	mux.HandleFunc(prefix+"territorial-summary", func(w http.ResponseWriter, r *http.Request) {
		respond(w, r, log, func(scope tenancy.Scope) (int, any, error) {
			summary, err := service.Summary(r.Context(), scope)
			return http.StatusOK, summary, err
		})
	})
}

// respond writes the work's status and JSON, or the TypeScript API's onError 500 when the
// request has no resolved project or the work fails.
func respond(w http.ResponseWriter, r *http.Request, log *slog.Logger, work func(tenancy.Scope) (int, any, error)) {
	scope, ok := tenancyhttp.ScopeFrom(r.Context())
	var (
		status int
		body   any
		err    = tenancyhttp.ErrNoScope
	)
	if ok {
		status, body, err = work(scope)
	}
	if err != nil {
		// Only the event: driver errors may carry connection details.
		if log != nil {
			log.LogAttrs(r.Context(), slog.LevelError, "intelligence read failed",
				slog.String("request_id", httpx.RequestIDFrom(r.Context())))
		}
		httpx.WriteError(w, http.StatusInternalServerError, "Internal Server Error")
		return
	}
	httpx.WriteJSONText(w, status, body)
}
