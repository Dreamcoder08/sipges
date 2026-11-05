package http

import (
	"log/slog"
	"net/http"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/intelligence/application"
	tenancy "github.com/Dreamcoder08/sipges/apps/api-go/internal/tenancy/domain"
)

// EmbedderSettings are the deployment facts GET /system/intelligence/embedder reports.
type EmbedderSettings struct {
	Configured     bool
	SemanticSearch bool
}

type embedderJSON struct {
	Configured     bool    `json:"configured"`
	Available      bool    `json:"available"`
	Reason         *string `json:"reason"`
	Model          string  `json:"model"`
	Egress         string  `json:"egress"`
	SemanticSearch bool    `json:"semantic_search"`
}

// EmbedderRoute registers GET /system/intelligence/embedder: whether semantic features can run.
// The web falls back to keyword search when they cannot.
func EmbedderRoute(mux *http.ServeMux, probe *application.EmbedderProbe, settings EmbedderSettings, log *slog.Logger) {
	mux.HandleFunc("GET /system/intelligence/embedder", func(w http.ResponseWriter, r *http.Request) {
		respond(w, r, log, func(scope tenancy.Scope) (int, any, error) {
			status, err := probe.Status(r.Context(), scope)
			out := embedderJSON{
				Configured: settings.Configured, Available: status.Available, Model: status.Model,
				Egress: status.Egress, SemanticSearch: settings.SemanticSearch,
			}
			if status.Reason != "" {
				out.Reason = &status.Reason
			}
			return http.StatusOK, out, err
		})
	})
}
