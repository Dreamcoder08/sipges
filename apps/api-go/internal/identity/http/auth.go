package http

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/identity/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/httpx"
)

// The login answers of auth-routes.ts, byte for byte. They never say which check refused.
var loginDetails = map[application.LoginFailure]string{
	application.InvalidCredentials: "Credenciales inválidas",
	application.InvalidOTP:         "Código de autenticación inválido",
	application.Throttled:          "Demasiados intentos fallidos; intente más tarde",
}

// loginTimeout bounds a login detached from its client, so it cannot hold a connection forever
// while it waits on a throttle lock.
const loginTimeout = 30 * time.Second

// maxBody bounds the form or JSON held in memory before any check, on routes anyone can reach or
// any account can send to. A longer body answers 422; the TypeScript API sets no limit of its own.
const maxBody = 1 << 20

// AuthDeps is what the authentication routes need.
type AuthDeps struct {
	Identity *application.Service
	// CookieSecure is SIPGES_COOKIE_SECURE: the Secure flag of the session cookie.
	CookieSecure bool
	ClientIP     httpx.ClientIPOptions
	Logger       *slog.Logger
	// TenantOf is the request's active project: tenancy resolves it, above this context.
	TenantOf func(r *http.Request) (string, bool)
}

// scopeCookie is SCOPE_COOKIE of cookies.ts: logout clears the project choice with the session.
const scopeCookie = "sipges_scope"

// issue is one FastAPI/pydantic-style validation error item (validation.ts ValidationIssue).
type issue struct {
	Type string `json:"type"`
	Loc  []any  `json:"loc"`
	Msg  string `json:"msg"`
}

var (
	formInvalid = []issue{{Type: "value_error", Loc: []any{"body"}, Msg: "Invalid form body"}}
	jsonInvalid = []issue{{Type: "json_invalid", Loc: []any{"body"}, Msg: "JSON decode error"}}
)

// The answers of the enrolment routes, byte for byte.
const (
	totpInstruction  = "Añada el código en una aplicación TOTP y confirme con /system/auth/totp/enable."
	totpEnabledError = "MFA ya está activado; no se permite reiniciar la configuración"
	totpCodeError    = "Código TOTP incorrecto"
)

type loginResponse struct {
	OK   bool   `json:"ok"`
	Name string `json:"name"`
	Role string `json:"role"`
}

// RegisterAuth adds the routes of auth-routes.ts ported so far.
func RegisterAuth(mux *http.ServeMux, deps AuthDeps) {
	h := authHandlers(deps)
	mux.HandleFunc("POST /login", h.login)
	mux.HandleFunc("POST /logout", h.logout)
	mux.HandleFunc("GET /system/auth/accounts", h.listAccounts)
	mux.HandleFunc("POST /system/auth/accounts", h.createAccount)
	mux.HandleFunc("POST /system/auth/accounts/{username}/deactivate", h.deactivateAccount)
	mux.HandleFunc("POST /system/auth/accounts/{username}/reset-mfa", h.resetMFA)
	if deps.Identity.CanEnrol() {
		mux.HandleFunc("POST /system/auth/totp/setup", h.totpSetup)
		mux.HandleFunc("POST /system/auth/totp/enable", h.totpEnable)
	}
}

type authHandlers AuthDeps

// fail answers an unexpected error as app.onError does. Only the event is logged: driver errors
// may carry connection details or the username.
func (h authHandlers) fail(w http.ResponseWriter, r *http.Request, event string) {
	if h.Logger != nil {
		h.Logger.LogAttrs(r.Context(), slog.LevelError, event,
			slog.String("request_id", httpx.RequestIDFrom(r.Context())))
	}
	httpx.WriteError(w, http.StatusInternalServerError, "Internal Server Error")
}

// readLoginForm is parseForm(c, LoginForm): the last value of each name wins, a file does not
// count as a value, and otp defaults to empty. It answers the 422 itself.
func readLoginForm(w http.ResponseWriter, r *http.Request) (username, password, otp string, ok bool) {
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxBody))
	if err != nil {
		httpx.WriteError(w, http.StatusUnprocessableEntity, formInvalid)
		return "", "", "", false
	}
	contentType, present := httpx.Header(r, "Content-Type")
	entries, parsed := httpx.ParseForm(contentType, present, body)
	if !parsed {
		httpx.WriteError(w, http.StatusUnprocessableEntity, formInvalid)
		return "", "", "", false
	}
	fields := map[string]*string{}
	for _, e := range entries {
		if strings.HasSuffix(e.Name, "[]") {
			continue // convertFormDataToBodyData makes a list: neither text nor a file
		}
		fields[e.Name] = nil
		if !e.File {
			fields[e.Name] = &e.Text
		}
	}
	var issues []issue
	for _, name := range []string{"username", "password"} {
		if fields[name] == nil {
			issues = append(issues, issue{Type: "missing", Loc: []any{"body", name}, Msg: "Field required"})
		}
	}
	if issues != nil {
		httpx.WriteError(w, http.StatusUnprocessableEntity, issues)
		return "", "", "", false
	}
	if value := fields["otp"]; value != nil {
		otp = *value
	}
	return *fields["username"], *fields["password"], otp, true
}

// login is POST /login. Passing the request's context to the service would let a client abort
// between the reservation and its release, so the login is detached from it.
func (h authHandlers) login(w http.ResponseWriter, r *http.Request) {
	username, password, otp, ok := readLoginForm(w, r)
	if !ok {
		return
	}
	ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), loginTimeout)
	defer cancel()
	result, err := h.Identity.Login(ctx, application.LoginInput{
		Username: username,
		Password: password,
		OTP:      otp,
		IP:       httpx.ClientIP(r, h.ClientIP),
	})
	switch {
	case err == nil && result.Failure == application.Throttled:
		w.Header().Set("Retry-After", strconv.Itoa(result.RetryAfterSeconds))
		httpx.WriteError(w, http.StatusTooManyRequests, loginDetails[result.Failure])
	case err != nil:
		h.fail(w, r, "login failed")
	case result.Failure != "":
		httpx.WriteError(w, http.StatusUnauthorized, loginDetails[result.Failure])
	default:
		w.Header().Add("Set-Cookie", httpx.AuthCookie(SessionCookie, result.Token, h.CookieSecure, application.SessionSeconds))
		httpx.WriteJSON(w, http.StatusOK, loginResponse{OK: true, Name: result.FullName, Role: string(result.Role)})
	}
}

// field is one string of a z.object; defaultValue makes it z.string().default(…).
type field struct {
	name         string
	defaultValue *string
}

// readJSON is parseJson over a z.object of strings: 422 for a body JSON.parse refuses or the
// schema rejects. A required field absent from the input is "missing".
func readJSON(w http.ResponseWriter, r *http.Request, fields ...field) ([]string, bool) {
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxBody))
	if err != nil {
		httpx.WriteError(w, http.StatusUnprocessableEntity, jsonInvalid)
		return nil, false
	}
	parsed, ok := httpx.ParseJSONBody(body)
	if !ok {
		httpx.WriteError(w, http.StatusUnprocessableEntity, jsonInvalid)
		return nil, false
	}
	if parsed.Kind != httpx.JSONObject {
		httpx.WriteError(w, http.StatusUnprocessableEntity, []issue{{Type: "invalid_type", Loc: []any{"body"},
			Msg: "Invalid input: expected object, received " + string(parsed.Kind)}})
		return nil, false
	}
	var issues []issue
	values := make([]string, len(fields))
	for i, f := range fields {
		switch v, present := parsed.Fields[f.name]; {
		case !present && f.defaultValue != nil:
			values[i] = *f.defaultValue
		case !present:
			issues = append(issues, issue{Type: "missing", Loc: []any{"body", f.name}, Msg: "Field required"})
		case v.Kind != httpx.JSONString:
			issues = append(issues, issue{Type: "invalid_type", Loc: []any{"body", f.name},
				Msg: "Invalid input: expected string, received " + string(v.Kind)})
		default:
			values[i] = v.Text
		}
	}
	if issues != nil {
		httpx.WriteError(w, http.StatusUnprocessableEntity, issues)
		return nil, false
	}
	return values, true
}

type totpSetupResponse struct {
	Secret      string `json:"secret"`
	OtpauthURI  string `json:"otpauth_uri"`
	Instruction string `json:"instruction"`
}

type totpEnabledResponse struct {
	OK          bool `json:"ok"`
	TOTPEnabled bool `json:"totp_enabled"`
}

// totpSetup is POST /system/auth/totp/setup; the secret leaves the server only here.
func (h authHandlers) totpSetup(w http.ResponseWriter, r *http.Request) {
	p, ok := PrincipalFrom(r.Context())
	if !ok {
		h.fail(w, r, "totp setup failed")
		return
	}
	enrollment, err := h.Identity.SetupTOTP(r.Context(), p.Username)
	switch {
	case err != nil:
		h.fail(w, r, "totp setup failed")
	case enrollment == nil:
		httpx.WriteError(w, http.StatusConflict, totpEnabledError)
	default:
		httpx.WriteJSON(w, http.StatusOK, totpSetupResponse{enrollment.Secret, enrollment.URI, totpInstruction})
	}
}

// totpEnable is POST /system/auth/totp/enable.
func (h authHandlers) totpEnable(w http.ResponseWriter, r *http.Request) {
	values, ok := readJSON(w, r, field{name: "code"})
	if !ok {
		return
	}
	p, ok := PrincipalFrom(r.Context())
	if !ok {
		h.fail(w, r, "totp enable failed")
		return
	}
	token, _ := httpx.Cookie(r, SessionCookie)
	enabled, err := h.Identity.EnableTOTP(r.Context(), p.Username, values[0], token)
	switch {
	case err != nil:
		h.fail(w, r, "totp enable failed")
	case !enabled:
		httpx.WriteError(w, http.StatusUnprocessableEntity, totpCodeError)
	default:
		httpx.WriteJSON(w, http.StatusOK, totpEnabledResponse{true, true})
	}
}
