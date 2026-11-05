package http

import (
	"context"
	"io"
	"log/slog"
	"net/http"

	identityhttp "github.com/Dreamcoder08/sipges/apps/api-go/internal/identity/http"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/httpx"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/prevention/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/prevention/domain"
	records "github.com/Dreamcoder08/sipges/apps/api-go/internal/records/domain"
	tenancyhttp "github.com/Dreamcoder08/sipges/apps/api-go/internal/tenancy/http"
)

// writeErrors are CREATE_ERRORS and UPDATE_ERRORS of prevention-routes.ts, byte for byte.
var writeErrors = map[domain.UpdateError]struct {
	status int
	detail string
}{
	domain.ErrAlertMissing:      {http.StatusNotFound, "Alerta no pertenece al proyecto indicado"},
	domain.ErrAlertUnverified:   {http.StatusConflict, "La alerta necesita verificación antes de crear un plan"},
	domain.ErrStatus:            {http.StatusUnprocessableEntity, "Estado no válido"},
	domain.ErrCompletedProgress: {http.StatusUnprocessableEntity, "Una acción completada debe indicar 100%"},
	domain.ErrPendingProgress:   {http.StatusUnprocessableEntity, "Seleccione En ejecución cuando haya avance"},
	domain.ErrEvidenceURL:       {http.StatusUnprocessableEntity, "Evidencia: use enlace http(s)"},
	domain.ErrMissing:           {http.StatusNotFound, "Acción no encontrada"},
	domain.ErrReactivate:        {http.StatusConflict, "No puede reactivar una acción cancelada"},
	domain.ErrNoteRequired:      {http.StatusUnprocessableEntity, "Justifique el cierre o cancelación"},
	domain.ErrEvidenceRequired:  {http.StatusUnprocessableEntity, "Adjunte la evidencia que respalda el cierre de la acción"},
	domain.ErrEvidenceMissing:   {http.StatusNotFound, "Evidencia no encontrada en el proyecto"},
	domain.ErrBlocker:           {http.StatusUnprocessableEntity, "Bloqueo no válido"},
}

type writtenJSON struct {
	Action       actionJSON `json:"action"`
	IRSAModified bool       `json:"irsa_modified"`
}

// WriteRoutes registers the prevention writes on mux. Session, Origin, project scope (with the
// body's project check) and role gate ran before (internal/app).
func WriteRoutes(mux *http.ServeMux, service application.Service, log *slog.Logger) {
	mux.HandleFunc("POST /system/prevention/actions", func(w http.ResponseWriter, r *http.Request) {
		body, ok := parsedBody(w, r)
		if !ok {
			return
		}
		in, issues := domain.ParseCreate(body)
		if issues != nil {
			writeIssues(w, issues)
			return
		}
		scope, ok := tenancyhttp.ScopeFrom(r.Context())
		if !ok {
			failWrite(w, r, log)
			return
		}
		action, refused, err := service.Create(r.Context(), scope, in)
		answer(w, r, log, action, refused, err)
	})

	mux.HandleFunc("PATCH /system/prevention/actions/{id}", func(w http.ResponseWriter, r *http.Request) {
		body, ok := parsedBody(w, r)
		if !ok {
			return
		}
		in, issues := domain.ParseUpdate(body)
		if issues != nil {
			writeIssues(w, issues)
			return
		}
		scope, hasScope := tenancyhttp.ScopeFrom(r.Context())
		principal, hasPrincipal := identityhttp.PrincipalFrom(r.Context())
		if !hasScope || !hasPrincipal {
			failWrite(w, r, log)
			return
		}
		action, refused, err := service.Update(r.Context(), scope, httpx.PathParam(r, "id"), in, principal.Username)
		answer(w, r, log, action, refused, err)
	})
}

// parsedBody is parseJson's first half: c.req.json(), or the 422 json_invalid.
func parsedBody(w http.ResponseWriter, r *http.Request) (any, bool) {
	data, err := io.ReadAll(r.Body)
	if err == nil {
		var body any
		if body, err = records.ParseBody(data); err == nil {
			return body, true
		}
	}
	writeIssues(w, records.JSONInvalid)
	return nil, false
}

func writeIssues(w http.ResponseWriter, issues []records.Issue) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusUnprocessableEntity)
	_, _ = w.Write(records.AppendIssues(nil, issues)) // the status is already sent
}

func answer(w http.ResponseWriter, r *http.Request, log *slog.Logger, action domain.PreventiveAction, refused domain.UpdateError, err error) {
	if err != nil {
		failWrite(w, r, log)
		return
	}
	if refused != "" {
		e := writeErrors[refused]
		httpx.WriteJSONText(w, e.status, httpx.ErrorBody{Detail: e.detail})
		return
	}
	httpx.WriteJSONText(w, http.StatusOK, writtenJSON{Action: toActionJSON(action)})
}

// failWrite is the TypeScript API's onError 500; only the event is logged, because driver errors
// may carry connection details.
func failWrite(w http.ResponseWriter, r *http.Request, log *slog.Logger) {
	if log != nil {
		log.LogAttrs(context.WithoutCancel(r.Context()), slog.LevelError, "prevention write failed",
			slog.String("request_id", httpx.RequestIDFrom(r.Context())))
	}
	httpx.WriteError(w, http.StatusInternalServerError, "Internal Server Error")
}
