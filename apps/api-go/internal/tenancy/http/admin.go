package http

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"

	identityhttp "github.com/Dreamcoder08/sipges/apps/api-go/internal/identity/http"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/httpx"
	records "github.com/Dreamcoder08/sipges/apps/api-go/internal/records/domain"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/tenancy/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/tenancy/domain"
)

// SessionSeconds is SESSION_SECONDS: the project cookie lives as long as a session (8 h).
const SessionSeconds = 8 * 3600

// createErrors is CREATE_ERRORS of tenancy-routes.ts.
var createErrors = map[string]struct {
	status int
	detail string
}{
	application.ErrForbidden:   {http.StatusForbidden, "Administrador requerido"},
	domain.ErrInvalidIDs:       {http.StatusUnprocessableEntity, "IDs inválidos"},
	domain.ErrReserved:         {http.StatusConflict, "Proyecto reservado"},
	application.ErrUserMissing: {http.StatusNotFound, "Usuario no existe"},
	application.ErrExists:      {http.StatusConflict, "Proyecto existente"},
}

// grantErrors is GRANT_ERRORS of tenancy-routes.ts.
var grantErrors = map[string]struct {
	status int
	detail string
}{
	application.ErrForbidden:     {http.StatusForbidden, "Forbidden"},
	application.ErrUserMissing:   {http.StatusNotFound, "Usuario inexistente"},
	application.ErrTenantMissing: {http.StatusNotFound, "Proyecto inexistente"},
	application.ErrGrantMissing:  {http.StatusNotFound, "Acceso inexistente"},
}

// AdminDeps is what the administration routes need.
type AdminDeps struct {
	Admin    application.Admin
	Sessions identityhttp.Authenticator
	// CookieSecure is SIPGES_COOKIE_SECURE: the Secure flag of the project cookie.
	CookieSecure bool
	Logger       *slog.Logger
}

type scopeSummary struct {
	CompanyID string `json:"company_id"`
	ProjectID string `json:"project_id"`
	Label     string `json:"label"`
}

type okBody struct {
	OK bool `json:"ok"`
}

type scopeCreated struct {
	OK    bool   `json:"ok"`
	Scope string `json:"scope"`
}

// RegisterAdmin adds the rest of tenancy-routes.ts to mux: the project choice
// (GET/POST /select-project), the user's projects (GET /system/auth/scopes), project creation
// (POST /system/auth/scopes), grants (POST/DELETE /system/auth/grants) and the project's export
// (GET /system/export). The session, Origin and role gates already ran; the export is the one
// path here with a resolved project.
func RegisterAdmin(mux *http.ServeMux, deps AdminDeps) {
	h := adminHandlers(deps)
	mux.HandleFunc("GET /select-project", h.selectPage)
	mux.HandleFunc("POST /select-project", h.selectProject)
	mux.HandleFunc("GET /system/auth/scopes", h.scopes)
	mux.HandleFunc("POST /system/auth/scopes", h.createScope)
	mux.HandleFunc("POST /system/auth/grants", h.grant)
	mux.HandleFunc("DELETE /system/auth/grants", h.revoke)
	mux.HandleFunc("GET /system/export", h.export)
}

type adminHandlers AdminDeps

// fail answers an unexpected error as app.onError does, after logging it.
func (h adminHandlers) fail(w http.ResponseWriter, r *http.Request, err error) {
	if h.Logger != nil {
		h.Logger.LogAttrs(r.Context(), slog.LevelError, "tenancy administration failed",
			slog.String("request_id", httpx.RequestIDFrom(r.Context())), slog.String("error", err.Error()))
	}
	httpx.WriteError(w, http.StatusInternalServerError, "Internal Server Error")
}

// actor is c.get('identity'): set by the session middleware on every path but the public ones.
func actor(r *http.Request) (application.Actor, bool) {
	p, ok := identityhttp.PrincipalFrom(r.Context())
	if !ok || p == nil {
		return application.Actor{}, false
	}
	return application.Actor{Username: p.Username, Role: string(p.Role)}, true
}

// readJSON is parseJson: 422 for a body JSON.parse refuses or the schema rejects.
func readJSON(w http.ResponseWriter, r *http.Request, s schema) ([]string, bool) {
	body, err := io.ReadAll(r.Body)
	if err != nil {
		httpx.WriteError(w, http.StatusUnprocessableEntity, jsonInvalid)
		return nil, false
	}
	parsed, ok := httpx.ParseJSONBody(body)
	if !ok {
		httpx.WriteError(w, http.StatusUnprocessableEntity, jsonInvalid)
		return nil, false
	}
	values, issues := s.parse(parsed)
	if issues != nil {
		httpx.WriteError(w, http.StatusUnprocessableEntity, issues)
		return nil, false
	}
	return values, true
}

// export is GET /system/export: the whole answer is built before the status goes out, so a
// failed read answers 500 and never a partial dump.
func (h adminHandlers) export(w http.ResponseWriter, r *http.Request) {
	a, ok := actor(r)
	scope, hasScope := ScopeFrom(r.Context())
	if !ok || !hasScope {
		h.fail(w, r, errNoActor)
		return
	}
	data, code, err := h.Admin.ExportData(r.Context(), a, scope)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	if code != "" {
		httpx.WriteError(w, http.StatusForbidden, "Requiere rol administrador")
		return
	}
	w.Header().Set("Content-Disposition", `attachment; filename="sipges-tenant.json"`)
	w.Header().Set("Content-Type", "application/json; charset=UTF-8")
	w.Header().Set("Cache-Control", "no-store") // securityHeaders on the TypeScript side
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(records.Stringify(data)) //nolint:gosec // an application/json attachment; the status is already sent
}

func (h adminHandlers) scopes(w http.ResponseWriter, r *http.Request) {
	a, ok := actor(r)
	if !ok {
		h.fail(w, r, errNoActor)
		return
	}
	grants, err := h.Admin.ListGranted(r.Context(), a.Username)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	out := make([]scopeSummary, 0, len(grants))
	for _, g := range grants {
		out = append(out, scopeSummary{CompanyID: g.CompanyID, ProjectID: g.ProjectID, Label: g.Label})
	}
	httpx.WriteJSON(w, http.StatusOK, out)
}

func (h adminHandlers) createScope(w http.ResponseWriter, r *http.Request) {
	values, ok := readJSON(w, r, scopeCreate)
	if !ok {
		return
	}
	a, ok := actor(r)
	if !ok {
		h.fail(w, r, errNoActor)
		return
	}
	scope, code, err := h.Admin.CreateTenant(r.Context(), a, domain.NewTenant{
		Scope: domain.Scope{CompanyID: values[0], ProjectID: values[1]}, Label: values[2], Username: values[3],
	})
	switch {
	case err != nil:
		h.fail(w, r, err)
	case code != "":
		e := createErrors[code]
		httpx.WriteError(w, e.status, e.detail)
	default:
		httpx.WriteJSON(w, http.StatusOK, scopeCreated{OK: true, Scope: scope})
	}
}

func (h adminHandlers) grant(w http.ResponseWriter, r *http.Request) {
	h.grantChange(w, r, grantCreate, h.Admin.Grant)
}

func (h adminHandlers) revoke(w http.ResponseWriter, r *http.Request) {
	h.grantChange(w, r, grantRevoke, h.Admin.Revoke)
}

func (h adminHandlers) grantChange(w http.ResponseWriter, r *http.Request, s schema,
	change func(context.Context, application.Actor, string, domain.Scope) (string, error),
) {
	values, ok := readJSON(w, r, s)
	if !ok {
		return
	}
	a, ok := actor(r)
	if !ok {
		h.fail(w, r, errNoActor)
		return
	}
	code, err := change(r.Context(), a, values[0], domain.Scope{CompanyID: values[1], ProjectID: values[2]})
	switch {
	case err != nil:
		h.fail(w, r, err)
	case code != "":
		e := grantErrors[code]
		httpx.WriteError(w, e.status, e.detail)
	default:
		httpx.WriteJSON(w, http.StatusOK, okBody{OK: true})
	}
}

// session is identity.authenticate(getCookie(c, SESSION_COOKIE)) on a public route.
func (h adminHandlers) session(r *http.Request) (application.Actor, bool, error) {
	token, _ := httpx.Cookie(r, identityhttp.SessionCookie)
	p, err := h.Sessions.Authenticate(r.Context(), token)
	if err != nil || p == nil {
		return application.Actor{}, false, err
	}
	return application.Actor{Username: p.Username, Role: string(p.Role)}, true, nil
}

// redirect is c.redirect(location, 303): a Location header and no body.
func redirect(w http.ResponseWriter, location string) {
	w.Header().Set("Location", location)
	w.WriteHeader(http.StatusSeeOther)
}

// selectPage is GET /select-project: anonymous visitors go to the login page.
func (h adminHandlers) selectPage(w http.ResponseWriter, r *http.Request) {
	a, ok, err := h.session(r)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	if !ok {
		redirect(w, "/login")
		return
	}
	grants, err := h.Admin.ListGranted(r.Context(), a.Username)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=UTF-8")
	w.WriteHeader(http.StatusOK)
	_, _ = io.WriteString(w, selectProjectPage(grants))
}

// selectProject is POST /select-project: a granted choice goes into the scope cookie.
func (h adminHandlers) selectProject(w http.ResponseWriter, r *http.Request) {
	a, ok, err := h.session(r)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	if !ok {
		httpx.WriteError(w, http.StatusUnauthorized, "Unauthorized")
		return
	}
	form, err := parseFormBody(r)
	if err != nil {
		httpx.WriteError(w, http.StatusUnprocessableEntity, formInvalid)
		return
	}
	values, issues := selectProjectForm.parse(form)
	if issues != nil {
		httpx.WriteError(w, http.StatusUnprocessableEntity, issues)
		return
	}
	granted, err := h.Admin.IsGranted(r.Context(), a.Username, values[0])
	if err != nil {
		h.fail(w, r, err)
		return
	}
	if !granted {
		httpx.WriteError(w, http.StatusForbidden, "Proyecto no autorizado")
		return
	}
	w.Header().Add("Set-Cookie", authCookie(ScopeCookie, values[0], h.CookieSecure, SessionSeconds))
	redirect(w, "/")
}

// authCookie is setAuthCookie through Hono's serialize: the value encodeURIComponent-encoded,
// then Max-Age, Path, HttpOnly, Secure and SameSite in that order.
func authCookie(name, value string, secure bool, maxAge int) string {
	cookie := fmt.Sprintf("%s=%s; Max-Age=%d; Path=/; HttpOnly", name, encodeURIComponent(value), maxAge)
	if secure {
		cookie += "; Secure"
	}
	return cookie + "; SameSite=Strict"
}

// encodeURIComponent keeps A-Z a-z 0-9 - _ . ! ~ * ' ( ) and percent-encodes every other UTF-8
// byte in upper-case hex.
func encodeURIComponent(s string) string {
	var out strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		if (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || strings.IndexByte("-_.!~*'()", c) >= 0 {
			out.WriteByte(c)
			continue
		}
		fmt.Fprintf(&out, "%%%02X", c)
	}
	return out.String()
}

var htmlEscaper = strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", `"`, "&quot;", "'", "&#x27;")

// selectProjectPage is the markup of app.py select_project_page, every value HTML-escaped.
func selectProjectPage(grants []domain.Grant) string {
	var options strings.Builder
	for _, g := range grants {
		scope := htmlEscaper.Replace(g.TenantID())
		fmt.Fprintf(&options, `<option value="%s">%s (%s)</option>`, scope, htmlEscaper.Replace(g.Label), scope)
	}
	return `<html lang="es"><meta charset="utf-8"><title>Seleccionar proyecto SIPGES</title>` +
		`<body style="font:18px system-ui;max-width:600px;margin:10vh auto"><h1>Selecciona tu proyecto autorizado</h1>` +
		`<form method="post" action="/select-project"><select name="scope" style="padding:12px;width:100%">` +
		options.String() +
		`</select><p><button style="padding:12px">Entrar al proyecto</button></p></form></body></html>`
}

// errNoActor is unreachable behind the session middleware; a handler refuses rather than act
// for nobody.
var errNoActor = fmt.Errorf("tenancy: the request has no session")
