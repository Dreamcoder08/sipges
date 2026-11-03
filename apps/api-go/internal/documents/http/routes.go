// Package http serves the read route of
// apps/api/src/contexts/documents/http/document-lab-routes.ts with the same JSON:
// GET /system/document-lab/review, one page of the verification inbox. The scope's project is
// always used (a query project_id naming another one was refused before); the session, project
// scope and role gate ran before (internal/app).
package http

import (
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/documents/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/documents/domain"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/httpx"
	tenancyhttp "github.com/Dreamcoder08/sipges/apps/api-go/internal/tenancy/http"
)

// Limitations is the notice every inbox page carries.
const Limitations = "Revisado no implica verdad certificada: comprobar fuente y documentación."

var (
	invalidLimit  = fmt.Sprintf("Parámetro limit inválido: use un entero de 1 a %d", domain.MaxReviewPage)
	invalidOffset = "Parámetro offset inválido: use un entero mayor o igual a 0"
)

// isoSeconds is isoSeconds of platform/http/time.ts: ISO 8601 UTC without fractional seconds.
func isoSeconds(t time.Time) string { return t.UTC().Format("2006-01-02T15:04:05Z") }

type itemJSON struct {
	ID           string                  `json:"id"`
	ProjectID    string                  `json:"project_id"`
	SourceFile   string                  `json:"source_file"`
	SourceSHA256 string                  `json:"source_sha256"`
	Location     string                  `json:"location"`
	Theme        string                  `json:"theme"`
	Excerpt      string                  `json:"excerpt"`
	Action       string                  `json:"action"`
	Status       string                  `json:"status"`
	Reviewer     string                  `json:"reviewer"`
	Note         string                  `json:"note"`
	CreatedAt    string                  `json:"created_at"`
	UpdatedAt    string                  `json:"updated_at"`
	Target       domain.ReviewTarget     `json:"target"`
	Record       *application.RecordLink `json:"record"`
}

type pageJSON struct {
	Items       []itemJSON         `json:"items"`
	Total       int64              `json:"total"`
	Limit       int64              `json:"limit"`
	Offset      int64              `json:"offset"`
	Themes      domain.ThemeCounts `json:"themes"`
	Limitations string             `json:"limitations"`
}

// toItemJSON is reviewJson of document-lab-routes.ts.
func toItemJSON(it application.ReviewListItem) itemJSON {
	return itemJSON{
		ID: it.ID, ProjectID: it.ProjectID, SourceFile: it.SourceFile, SourceSHA256: it.SourceSHA256,
		Location: it.Location, Theme: it.Theme, Excerpt: it.Excerpt, Action: it.Action, Status: it.Status,
		Reviewer: it.Reviewer, Note: it.Note, CreatedAt: isoSeconds(it.CreatedAt), UpdatedAt: isoSeconds(it.UpdatedAt),
		Target: it.Target, Record: it.Record,
	}
}

// query is c.req.query(key) ?? null.
func query(r *http.Request, key string) *string {
	if v, ok := httpx.QueryParam(r, key); ok {
		return &v
	}
	return nil
}

// Routes registers the document lab's read route on mux.
func Routes(mux *http.ServeMux, service application.Service, log *slog.Logger) {
	mux.HandleFunc("GET /system/document-lab/review", func(w http.ResponseWriter, r *http.Request) {
		limit, offset := int64(domain.DefaultReviewPage), int64(0)
		if raw := query(r, "limit"); raw != nil {
			n, ok := domain.BoundedInt(*raw, 1, domain.MaxReviewPage)
			if !ok {
				httpx.WriteError(w, http.StatusUnprocessableEntity, invalidLimit)
				return
			}
			limit = n
		}
		if raw := query(r, "offset"); raw != nil {
			n, ok := domain.BoundedInt(*raw, 0, domain.MaxSafeInteger)
			if !ok {
				httpx.WriteError(w, http.StatusUnprocessableEntity, invalidOffset)
				return
			}
			offset = n
		}
		scope, ok := tenancyhttp.ScopeFrom(r.Context())
		var (
			page application.ReviewList
			err  = tenancyhttp.ErrNoScope
		)
		if ok {
			page, err = service.ListReview(r.Context(), scope, query(r, "status"), query(r, "theme"), limit, offset)
		}
		if err != nil {
			// Only the event: driver errors may carry connection details.
			if log != nil {
				log.LogAttrs(r.Context(), slog.LevelError, "document review read failed",
					slog.String("request_id", httpx.RequestIDFrom(r.Context())))
			}
			httpx.WriteError(w, http.StatusInternalServerError, "Internal Server Error")
			return
		}
		items := make([]itemJSON, 0, len(page.Items))
		for _, it := range page.Items {
			items = append(items, toItemJSON(it))
		}
		httpx.WriteJSON(w, http.StatusOK, pageJSON{
			Items: items, Total: page.Total, Limit: limit, Offset: offset, Themes: page.Themes, Limitations: Limitations,
		})
	})
}
