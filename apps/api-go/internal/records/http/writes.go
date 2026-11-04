package http

import (
	"io"
	"log/slog"
	"net/http"
	"strconv"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/httpx"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/records/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/records/domain"
)

// RegisterWrites mounts the write routes of records-routes.ts: POST /api/{module}, PUT and
// DELETE /api/{module}/{id} and POST /system/import/{module}. The session (with its Origin
// check on writes), project scope (with its body check) and role gate ran before (internal/app).
func RegisterWrites(mux *http.ServeMux, writes application.Writes, log *slog.Logger) {
	h := writeHandlers{handlers: handlers{log: log}, writes: writes}
	mux.HandleFunc("POST /api/{module}", h.create)
	mux.HandleFunc("PUT /api/{module}/{id}", h.replace)
	mux.HandleFunc("DELETE /api/{module}/{id}", h.remove)
	mux.HandleFunc("POST /system/import/{module}", h.importRows)
}

type writeHandlers struct {
	handlers
	writes application.Writes
}

var ok = []byte(`{"ok":true}`)

// body is parseJson's first half: c.req.json(), or the 422 json_invalid.
func body(w http.ResponseWriter, r *http.Request) (any, bool) {
	data, err := io.ReadAll(r.Body)
	if err == nil {
		var v any
		if v, err = domain.ParseBody(data); err == nil {
			return v, true
		}
	}
	writeJSON(w, http.StatusUnprocessableEntity, domain.AppendIssues(nil, domain.JSONInvalid))
	return nil, false
}

// payload is parseJson(c, RecordIn): the payload, or the 422 that refused the body.
func payload(w http.ResponseWriter, r *http.Request) (*domain.Object, bool) {
	v, parsed := body(w, r)
	if !parsed {
		return nil, false
	}
	p, issues := domain.RecordInput(v)
	if issues != nil {
		writeJSON(w, http.StatusUnprocessableEntity, domain.AppendIssues(nil, issues))
		return nil, false
	}
	return p, true
}

// invalidPayload is the per-module id rule the use case refused, FastAPI-style.
func invalidPayload(w http.ResponseWriter, problem *domain.Problem) {
	writeJSON(w, http.StatusUnprocessableEntity, domain.AppendIssues(nil, []domain.Issue{{
		Type: "value_error", Loc: []any{"payload", problem.Field}, Msg: problem.Message,
	}}))
}

func (h writeHandlers) create(w http.ResponseWriter, r *http.Request) {
	m, found := module(w, r)
	if !found {
		return
	}
	p, parsed := payload(w, r)
	if !parsed {
		return
	}
	tenant, scoped := h.tenant(w, r)
	if !scoped {
		return
	}
	id, problem, err := h.writes.Create(r.Context(), tenant, m, p)
	switch {
	case err != nil:
		h.fail(w, r)
	case problem != nil:
		invalidPayload(w, problem)
	default:
		b := append([]byte(`{"ok":true,"id":`), domain.AppendString(nil, id)...)
		writeJSON(w, http.StatusOK, append(b, '}'))
	}
}

func (h writeHandlers) replace(w http.ResponseWriter, r *http.Request) {
	m, found := module(w, r)
	if !found {
		return
	}
	p, parsed := payload(w, r)
	if !parsed {
		return
	}
	tenant, scoped := h.tenant(w, r)
	if !scoped {
		return
	}
	replaced, problem, err := h.writes.Replace(r.Context(), tenant, m, httpx.PathParam(r, "id"), p)
	switch {
	case err != nil:
		h.fail(w, r)
	case problem != nil:
		invalidPayload(w, problem)
	case !replaced:
		writeJSON(w, http.StatusNotFound, missingRecord)
	default:
		writeJSON(w, http.StatusOK, ok)
	}
}

func (h writeHandlers) remove(w http.ResponseWriter, r *http.Request) {
	m, found := module(w, r)
	if !found {
		return
	}
	tenant, scoped := h.tenant(w, r)
	if !scoped {
		return
	}
	removed, err := h.writes.Remove(r.Context(), tenant, m, httpx.PathParam(r, "id"))
	switch {
	case err != nil:
		h.fail(w, r)
	case !removed:
		writeJSON(w, http.StatusNotFound, missingRecord)
	default:
		writeJSON(w, http.StatusOK, ok)
	}
}

func (h writeHandlers) importRows(w http.ResponseWriter, r *http.Request) {
	m, found := domain.ModuleForSlug(httpx.PathParam(r, "module"))
	if !found || !domain.IsImportable(m) {
		writeJSON(w, http.StatusNotFound, unknownModule)
		return
	}
	v, parsed := body(w, r)
	if !parsed {
		return
	}
	in, issues := domain.ImportInput(v)
	if issues != nil {
		writeJSON(w, http.StatusUnprocessableEntity, domain.AppendIssues(nil, issues))
		return
	}
	tenant, scoped := h.tenant(w, r)
	if !scoped {
		return
	}
	report, err := h.writes.ImportRows(r.Context(), tenant, m, in)
	if err != nil {
		h.fail(w, r)
		return
	}
	b := []byte(`{"applied":`)
	b = strconv.AppendBool(b, report.Applied)
	b = append(b, `,"created":`...)
	b = strconv.AppendInt(b, int64(report.Created), 10)
	b = append(b, `,"updated":`...)
	b = strconv.AppendInt(b, int64(report.Updated), 10)
	b = append(b, `,"problems":[`...)
	for i, p := range report.Problems {
		if i > 0 {
			b = append(b, ',')
		}
		b = append(b, `{"row":`...)
		b = strconv.AppendInt(b, int64(p.Row), 10)
		b = append(b, `,"message":`...)
		b = domain.AppendString(b, p.Message)
		b = append(b, '}')
	}
	status := http.StatusOK
	if len(report.Problems) > 0 && !in.DryRun {
		status = http.StatusUnprocessableEntity
	}
	writeJSON(w, status, append(b, "]}"...))
}
