package http

import (
	"encoding/json"
	"log/slog"
	"net/http"

	identityhttp "github.com/Dreamcoder08/sipges/apps/api-go/internal/identity/http"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/intelligence/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/intelligence/domain"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/httpx"
	tenancyhttp "github.com/Dreamcoder08/sipges/apps/api-go/internal/tenancy/http"
)

var writeJSON = httpx.WriteJSONText

// The bodies of intelligence-routes.ts, byte for byte.
var textErrors = map[application.TextError]struct {
	status int
	detail string
}{
	"empty":    {http.StatusUnprocessableEntity, "Ingrese el texto transcrito de la publicación."}, //nolint:misspell // Spanish, verbatim from intelligence-routes.ts
	"too_long": {http.StatusRequestEntityTooLarge, "Máximo 20 000 caracteres."},
}

var decisionErrors = map[domain.DecisionError]struct {
	status int
	detail string
}{
	domain.ErrStatus:      {http.StatusUnprocessableEntity, "Estado inválido"},
	domain.ErrNoteTooLong: {http.StatusUnprocessableEntity, "Nota demasiado extensa"},
	domain.ErrMissing:     {http.StatusNotFound, "Evaluación no encontrada"},
	domain.ErrSamePerson:  {http.StatusConflict, "Otra persona debe confirmar la validación de una alerta de prioridad Alta"},
}

// The schemas of intelligence-routes.ts. project_id is accepted for compatibility: the
// tenancy middleware already refused any value other than the scope's project.
var (
	recordBody   = []field{{name: "payload", kind: recordField}}
	textBody     = []field{{name: "text"}, {name: "project_id", optional: true}, {name: "source_url", optional: true}}
	decisionBody = []field{{name: "status"}, {name: "reviewer_note", optional: true}}
)

type decisionJSON struct {
	OK                       bool   `json:"ok"`
	Status                   string `json:"status"`
	SecondValidationRequired bool   `json:"second_validation_required"`
	IRSAModified             bool   `json:"irsa_modified"`
	Notice                   string `json:"notice"`
}

const decisionNotice = "La validación NO cambia el IRSA. Registrar cambios de indicadores requiere metodología aprobada."

// WriteRoutes registers the intelligence writes that need no embeddings provider:
// POST /system/analyze, POST /system/intelligence/analyze-text and
// PATCH /system/intelligence/territorial-alerts/{id}. Session, Origin, project scope (with the
// body's project check) and role gate ran before (internal/app).
func WriteRoutes(mux *http.ServeMux, writes application.Writes, log *slog.Logger) {
	mux.HandleFunc("POST /system/analyze", func(w http.ResponseWriter, r *http.Request) {
		b, ok := parseBody(w, r, recordBody)
		if !ok {
			return
		}
		value, err := writes.Classify(r.Context(), b["payload"])
		if err != nil {
			fail(w, r, log, err)
			return
		}
		writeRaw(w, value)
	})

	mux.HandleFunc("POST /system/intelligence/analyze-text", func(w http.ResponseWriter, r *http.Request) {
		b, ok := parseBody(w, r, textBody)
		if !ok {
			return
		}
		scope, ok := tenancyhttp.ScopeFrom(r.Context())
		if !ok {
			fail(w, r, log, tenancyhttp.ErrNoScope)
			return
		}
		report, kind, err := writes.AnalyzeText(r.Context(), scope, b.str("text"), b.str("source_url"))
		if err != nil {
			fail(w, r, log, err)
			return
		}
		if e, known := textErrors[kind]; known {
			writeJSON(w, e.status, httpx.ErrorBody{Detail: e.detail})
			return
		}
		writeRaw(w, report)
	})

	mux.HandleFunc("PATCH /system/intelligence/territorial-alerts/{id}", func(w http.ResponseWriter, r *http.Request) {
		b, ok := parseBody(w, r, decisionBody)
		if !ok {
			return
		}
		scope, hasScope := tenancyhttp.ScopeFrom(r.Context())
		principal, hasPrincipal := identityhttp.PrincipalFrom(r.Context())
		if !hasScope || !hasPrincipal {
			fail(w, r, log, tenancyhttp.ErrNoScope)
			return
		}
		result, err := writes.DecideAlert(r.Context(), scope, httpx.PathParam(r, "id"),
			b.str("status"), b.str("reviewer_note"), principal.Username)
		if err != nil {
			fail(w, r, log, err)
			return
		}
		if e, failed := decisionErrors[result.Err]; failed {
			writeJSON(w, e.status, httpx.ErrorBody{Detail: e.detail})
			return
		}
		writeJSON(w, http.StatusOK, decisionJSON{
			OK: true, Status: result.Status, SecondValidationRequired: result.PendingSecond, Notice: decisionNotice,
		})
	})
}

// writeRaw sends an engine value: already JSON.stringify of the TypeScript result.
func writeRaw(w http.ResponseWriter, value json.RawMessage) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(value) // the status is already sent; a failed write has no recovery
}

// fail answers the TypeScript API's onError 500, logging only the event: driver and engine
// errors may carry connection or record details.
func fail(w http.ResponseWriter, r *http.Request, log *slog.Logger, _ error) {
	if log != nil {
		log.LogAttrs(r.Context(), slog.LevelError, "intelligence write failed",
			slog.String("request_id", httpx.RequestIDFrom(r.Context())))
	}
	httpx.WriteError(w, http.StatusInternalServerError, "Internal Server Error")
}
