package http

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"strings"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/identity/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/httpx"
)

// The login answers of auth-routes.ts, byte for byte. They never say which check refused.
var loginDetails = map[application.LoginFailure]string{
	application.InvalidCredentials: "Credenciales inválidas",
	application.InvalidOTP:         "Código de autenticación inválido",
	application.Throttled:          "Demasiados intentos fallidos; intente más tarde",
}

// maxLoginBody bounds the form held in memory before any check, on a route anyone can reach. A
// longer body answers 422 instead of the TypeScript API's 401, which sets no limit of its own.
const maxLoginBody = 1 << 20

// AuthDeps is what the authentication routes need.
type AuthDeps struct {
	Identity *application.Service
	// CookieSecure is SIPGES_COOKIE_SECURE: the Secure flag of the session cookie.
	CookieSecure bool
	ClientIP     httpx.ClientIPOptions
	Logger       *slog.Logger
}

// issue is one FastAPI/pydantic-style validation error item (validation.ts ValidationIssue).
type issue struct {
	Type string `json:"type"`
	Loc  []any  `json:"loc"`
	Msg  string `json:"msg"`
}

var formInvalid = []issue{{Type: "value_error", Loc: []any{"body"}, Msg: "Invalid form body"}}

type loginResponse struct {
	OK   bool   `json:"ok"`
	Name string `json:"name"`
	Role string `json:"role"`
}

// RegisterAuth adds the routes of auth-routes.ts ported so far.
func RegisterAuth(mux *http.ServeMux, deps AuthDeps) {
	h := authHandlers(deps)
	mux.HandleFunc("POST /login", h.login)
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
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxLoginBody))
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
	result, err := h.Identity.Login(context.WithoutCancel(r.Context()), application.LoginInput{
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
