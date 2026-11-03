// Package http serves the read routes of apps/api/src/contexts/records/http/records-routes.ts
// with the same JSON: GET /api/registros/summary, /api/{module}, /api/{module}/{id} and
// /api/{module}/{id}/history. The scope's tenant is always used; the session, project scope and
// role gate ran before (internal/app). POST, PUT and DELETE of records and POST
// /system/import/{module} stay in TypeScript.
package http

import (
	"errors"
	"fmt"
	"log/slog"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/httpx"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/records/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/records/domain"
	tenancyhttp "github.com/Dreamcoder08/sipges/apps/api-go/internal/tenancy/http"
)

var (
	unknownModule = []byte(`{"detail":"Módulo no válido"}`)
	missingRecord = []byte(`{"detail":"Registro no encontrado"}`)
	badOffset     = []byte(`{"detail":"offset debe ser un entero no negativo"}`)
	internalError = []byte(`{"detail":"Internal Server Error"}`)
)

// maxSafeInteger is Number.MAX_SAFE_INTEGER.
const maxSafeInteger = 1<<53 - 1

// Register mounts the records read routes on mux. «registros» is the hub, never a record type:
// its summary is more specific than /api/{module}/{id}, as Hono registers it first.
func Register(mux *http.ServeMux, service application.Service, log *slog.Logger) {
	h := handlers{service: service, log: log}
	mux.HandleFunc("GET /api/registros/summary", h.summary)
	mux.HandleFunc("GET /api/{module}", h.list)
	mux.HandleFunc("GET /api/{module}/{id}", h.get)
	mux.HandleFunc("GET /api/{module}/{id}/history", h.history)
}

type handlers struct {
	service application.Service
	log     *slog.Logger
}

// writeJSON sends body as Hono's c.json does: the bytes JSON.stringify gives, no newline.
func writeJSON(w http.ResponseWriter, status int, body []byte) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(body) // the status is already sent; a failed write has no recovery
}

// fail answers the TypeScript API's onError 500; only the event is logged, since driver
// errors may carry connection details.
func (h handlers) fail(w http.ResponseWriter, r *http.Request) {
	if h.log != nil {
		h.log.LogAttrs(r.Context(), slog.LevelError, "records read failed",
			slog.String("request_id", httpx.RequestIDFrom(r.Context())))
	}
	writeJSON(w, http.StatusInternalServerError, internalError)
}

// tenant is formatScope(c.get('scope')); without a resolved project nothing is read.
func (h handlers) tenant(w http.ResponseWriter, r *http.Request) (string, bool) {
	scope, ok := tenancyhttp.ScopeFrom(r.Context())
	if !ok {
		h.fail(w, r)
		return "", false
	}
	return scope.TenantID(), true
}

// module is moduleForSlug of the path's module, or the 404 «Módulo no válido».
func module(w http.ResponseWriter, r *http.Request) (string, bool) {
	m, ok := domain.ModuleForSlug(httpx.PathParam(r, "module"))
	if !ok {
		writeJSON(w, http.StatusNotFound, unknownModule)
	}
	return m, ok
}

// pageQuery is pageQuery of records-routes.ts: limit (default 200), offset (default 0, a
// non-negative safe integer) and q, in that order of validation.
func pageQuery(w http.ResponseWriter, r *http.Request) (application.Page, bool) {
	limit, ok := parseIntQuery(w, r, "limit", 200)
	if !ok {
		return application.Page{}, false
	}
	offset, ok := parseIntQuery(w, r, "offset", 0)
	if !ok {
		return application.Page{}, false
	}
	if offset < 0 || offset > maxSafeInteger {
		writeJSON(w, http.StatusUnprocessableEntity, badOffset)
		return application.Page{}, false
	}
	page := application.Page{Limit: limit, Offset: offset}
	if q, present := httpx.QueryParam(r, "q"); present {
		page.Q = &q
	}
	return page, true
}

func (h handlers) summary(w http.ResponseWriter, r *http.Request) {
	page, ok := pageQuery(w, r)
	if !ok {
		return
	}
	tenant, ok := h.tenant(w, r)
	if !ok {
		return
	}
	s, err := h.service.Summary(r.Context(), tenant, page)
	if err != nil {
		h.fail(w, r)
		return
	}
	b := []byte(`{"counts":{`)
	for i, c := range s.Counts {
		if i > 0 {
			b = append(b, ',')
		}
		b = domain.AppendString(b, c.Slug)
		b = append(b, ':')
		b = strconv.AppendInt(b, c.Count, 10)
	}
	b = append(b, `},"rows":[`...)
	for i, row := range s.Rows {
		if i > 0 {
			b = append(b, ',')
		}
		b = append(b, `{"module":`...)
		b = domain.AppendString(b, row.Slug)
		b = append(b, `,"id":`...)
		b = domain.AppendString(b, row.ID)
		b = append(b, `,"title":`...)
		b = domain.AppendString(b, row.Title)
		b = append(b, `,"territory":`...)
		b = domain.AppendString(b, row.Territory)
		b = append(b, `,"date":`...)
		b = domain.AppendString(b, row.Date)
		b = append(b, `,"verification":`...)
		if row.Verification == nil {
			b = append(b, "null"...)
		} else {
			b = domain.AppendString(b, *row.Verification)
		}
		b = append(b, `,"validation":`...)
		b = domain.AppendString(b, row.Validation)
		b = append(b, `,"updated_at":`...)
		b = domain.AppendString(b, isoSeconds(row.UpdatedAt))
		b = append(b, '}')
	}
	writeJSON(w, http.StatusOK, append(b, "]}"...))
}

func (h handlers) list(w http.ResponseWriter, r *http.Request) {
	m, ok := module(w, r)
	if !ok {
		return
	}
	page, ok := pageQuery(w, r)
	if !ok {
		return
	}
	tenant, ok := h.tenant(w, r)
	if !ok {
		return
	}
	rows, err := h.service.List(r.Context(), tenant, m, page)
	if err != nil {
		h.fail(w, r)
		return
	}
	b := []byte{'['}
	for i, row := range rows {
		if i > 0 {
			b = append(b, ',')
		}
		out := row.Payload.Clone() // { ...row.payload, _id, _updated_at }
		out.Set("_id", row.ID)
		out.Set("_updated_at", isoSeconds(row.UpdatedAt))
		b = domain.AppendJSON(b, out)
	}
	writeJSON(w, http.StatusOK, append(b, ']'))
}

func (h handlers) get(w http.ResponseWriter, r *http.Request) {
	m, ok := module(w, r)
	if !ok {
		return
	}
	tenant, ok := h.tenant(w, r)
	if !ok {
		return
	}
	row, err := h.service.Get(r.Context(), tenant, m, httpx.PathParam(r, "id"))
	if err != nil {
		h.fail(w, r)
		return
	}
	if row == nil {
		writeJSON(w, http.StatusNotFound, missingRecord)
		return
	}
	out := row.Payload.Clone()
	out.Set("_id", row.ID)
	writeJSON(w, http.StatusOK, domain.AppendJSON(nil, out))
}

func (h handlers) history(w http.ResponseWriter, r *http.Request) {
	m, ok := module(w, r)
	if !ok {
		return
	}
	tenant, ok := h.tenant(w, r)
	if !ok {
		return
	}
	versions, err := h.service.History(r.Context(), tenant, m, httpx.PathParam(r, "id"))
	if err != nil {
		h.fail(w, r)
		return
	}
	if len(versions) == 0 {
		writeJSON(w, http.StatusNotFound, missingRecord)
		return
	}
	b := []byte{'['}
	for i, v := range versions {
		if i > 0 {
			b = append(b, ',')
		}
		b = fmt.Appendf(b, `{"version":%d,"operation":`, v.Version)
		b = domain.AppendString(b, v.Operation)
		b = append(b, `,"actor":`...)
		b = domain.AppendString(b, v.Actor)
		b = append(b, `,"at":`...)
		b = domain.AppendString(b, isoSeconds(v.At))
		b = append(b, `,"payload":`...)
		if v.Payload == nil {
			b = append(b, "null"...)
		} else {
			b = domain.AppendJSON(b, v.Payload)
		}
		b = append(b, `,"changes":`...)
		b = domain.AppendChanges(b, v.Changes)
		b = append(b, '}')
	}
	writeJSON(w, http.StatusOK, append(b, ']'))
}

// parseIntQuery is parseIntQuery of apps/api/src/platform/http/validation.ts (FastAPI
// `limit: int = N`): the fallback when the parameter is absent, a 422 when it does not match
// /^\s*[+-]?\d+\s*$/, else its value, saturated at the int64 bounds (JavaScript reads larger
// ones as huge numbers, which every caller here clamps or refuses the same way).
func parseIntQuery(w http.ResponseWriter, r *http.Request, name string, fallback int64) (int64, bool) {
	raw, present := httpx.QueryParam(r, name)
	if !present {
		return fallback, true
	}
	if value, ok := parseJSInt(strings.TrimFunc(raw, isJSSpace)); ok {
		return value, true
	}
	b := append([]byte(`{"detail":[{"type":"int_parsing","loc":["query",`), domain.AppendString(nil, name)...)
	b = append(b, `],"msg":"Input should be a valid integer, unable to parse string as an integer"}]}`...)
	writeJSON(w, http.StatusUnprocessableEntity, b)
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
