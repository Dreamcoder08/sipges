package http

import (
	"log/slog"
	"net/http"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/intelligence/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/intelligence/domain"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/httpx"
	tenancyhttp "github.com/Dreamcoder08/sipges/apps/api-go/internal/tenancy/http"
)

// semanticBody is SemanticBody of intelligence-routes.ts.
var semanticBody = []field{
	{name: "text"}, {name: "project_id", optional: true}, {name: "source_url", optional: true}, {name: "mode", optional: true},
}

var semanticErrors = map[application.TextError]struct {
	status int
	detail string
}{
	application.ErrMode:       {http.StatusUnprocessableEntity, "Modo inválido"},
	application.ErrURL:        {http.StatusUnprocessableEntity, "URL pública inválida"},
	application.ErrSourceType: {http.StatusUnprocessableEntity, "Tipo de fuente inválido"},
	application.ErrUnavailable: {
		http.StatusServiceUnavailable,
		"Modelo local no disponible. Instale Ollama, descargue el modelo configurado o seleccione análisis por reglas.",
	},
}

// SemanticRoute registers POST /system/intelligence/semantic-analyze. Session, Origin, project
// scope (with the body's project check) and role gate ran before (internal/app); it stores nothing.
func SemanticRoute(mux *http.ServeMux, semantic *application.Semantic, log *slog.Logger) {
	mux.HandleFunc("POST /system/intelligence/semantic-analyze", func(w http.ResponseWriter, r *http.Request) {
		b, ok := parseBody(w, r, semanticBody)
		if !ok {
			return
		}
		scope, ok := tenancyhttp.ScopeFrom(r.Context())
		if !ok {
			fail(w, r, log, tenancyhttp.ErrNoScope)
			return
		}
		mode := domain.ModeAutomatic
		if _, sent := b["mode"]; sent {
			mode = b.str("mode")
		}
		report, kind, err := semantic.Analyze(r.Context(), scope, b.str("text"), b.str("source_url"), mode)
		if err != nil {
			fail(w, r, log, err)
			return
		}
		if e, known := textErrors[kind]; known {
			writeJSON(w, e.status, httpx.ErrorBody{Detail: e.detail})
			return
		}
		if e, known := semanticErrors[kind]; known {
			writeJSON(w, e.status, httpx.ErrorBody{Detail: e.detail})
			return
		}
		writeRaw(w, report)
	})
}
