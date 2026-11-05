package http

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"net/http"
	"regexp"
	"strings"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/identity/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/httpx"
)

// The Google flow of google-routes.ts (ADR 0010). flowCookie holds state, nonce and PKCE verifier
// between the redirect to Google and its return. Google sends the browser back cross-site, so
// this cookie is SameSite=Lax; the session stays Strict.
const (
	flowCookie   = "sipges_google_flow"
	flowSeconds  = 600
	googleStart  = "/auth/google"
	googleReturn = "/auth/google/callback"
)

var (
	flowPart = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)
	// callbackHost is the host the browser used, which the host allowlist already vetted.
	callbackHost = regexp.MustCompile(`^[A-Za-z0-9.-]+(:\d{1,5})?$`)
)

// linkErrors is LINK_ERRORS of google-routes.ts.
var linkErrors = map[application.AccountOutcome]struct {
	status int
	detail string
}{
	application.AccountForbidden:    {http.StatusForbidden, "Administración de cuentas restringida"},
	application.AccountInvalid:      {http.StatusUnprocessableEntity, "Usuario inválido"},
	application.AccountInvalidEmail: {http.StatusUnprocessableEntity, "Correo de Google inválido"},
	application.AccountMissing:      {http.StatusNotFound, "Usuario inexistente"},
	application.AccountTaken:        {http.StatusConflict, "Ese correo de Google ya está vinculado a otra cuenta"},
}

type googleLinked struct {
	OK          bool    `json:"ok"`
	Username    string  `json:"username"`
	GoogleEmail *string `json:"google_email"`
}

func randomPart() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

// redirectURI is where Google returns; "" for a host that cannot be written into it.
func (h authHandlers) redirectURI(r *http.Request) string {
	if !callbackHost.MatchString(r.Host) {
		return ""
	}
	if h.CookieSecure {
		return "https://" + r.Host + googleReturn
	}
	return "http://" + r.Host + googleReturn
}

func redirect(w http.ResponseWriter, location string) {
	w.Header().Set("Location", location)
	w.WriteHeader(http.StatusFound)
}

func failedGoogle(w http.ResponseWriter, reason string) { redirect(w, "/login?google="+reason) }

// googleBegin is GET /auth/google: the three random parts go in the cookie, then to Google.
func (h authHandlers) googleBegin(w http.ResponseWriter, r *http.Request) {
	uri := h.redirectURI(r)
	if uri == "" {
		httpx.WriteError(w, http.StatusBadRequest, "Host no permitido")
		return
	}
	state, err := randomPart()
	if err != nil {
		h.fail(w, r, "google sign-in failed")
		return
	}
	nonce, err := randomPart()
	if err != nil {
		h.fail(w, r, "google sign-in failed")
		return
	}
	verifier, err := randomPart()
	if err != nil {
		h.fail(w, r, "google sign-in failed")
		return
	}
	w.Header().Add("Set-Cookie", httpx.ScopedCookie(flowCookie, state+"."+nonce+"."+verifier, h.CookieSecure, flowSeconds, googleStart, "Lax"))
	redirect(w, h.Google.AuthorizationURL(application.GoogleAuthRequest{
		RedirectURI: uri, State: state, Nonce: nonce, CodeVerifier: verifier,
	}))
}

// googleCallback is GET /auth/google/callback: the flow cookie is single-use, and the state must
// match before anything reaches Google.
func (h authHandlers) googleCallback(w http.ResponseWriter, r *http.Request) {
	stored, _ := httpx.Cookie(r, flowCookie)
	w.Header().Add("Set-Cookie", httpx.ScopedCookie(flowCookie, "", h.CookieSecure, 0, googleStart, "Lax"))
	parts := append(strings.Split(stored, "."), "", "")
	state, nonce, verifier := parts[0], parts[1], parts[2]
	uri := h.redirectURI(r)
	returned, _ := httpx.QueryParam(r, "state")
	if !flowPart.MatchString(state) || !flowPart.MatchString(nonce) || !flowPart.MatchString(verifier) || uri == "" {
		failedGoogle(w, "expired")
		return
	}
	if subtle.ConstantTimeCompare([]byte(state), []byte(returned)) != 1 {
		failedGoogle(w, "expired")
		return
	}
	code, _ := httpx.QueryParam(r, "code")
	if refused, _ := httpx.QueryParam(r, "error"); refused != "" || code == "" {
		failedGoogle(w, "cancelled")
		return
	}
	request := application.GoogleAuthRequest{RedirectURI: uri, State: state, Nonce: nonce, CodeVerifier: verifier}
	profile, err := h.Google.Exchange(r.Context(), code, request, h.Clock())
	if err != nil {
		h.fail(w, r, "google sign-in failed")
		return
	}
	if profile == nil {
		failedGoogle(w, "failed")
		return
	}
	result, err := h.Identity.LoginWithGoogle(r.Context(), profile.Email)
	if err != nil {
		h.fail(w, r, "google sign-in failed")
		return
	}
	if result.Failure != "" {
		failedGoogle(w, "not_linked")
		return
	}
	w.Header().Add("Set-Cookie", httpx.AuthCookie(SessionCookie, result.Token, h.CookieSecure, application.SessionSeconds))
	redirect(w, "/")
}

// linkGoogle is POST /system/auth/accounts/:username/google.
func (h authHandlers) linkGoogle(w http.ResponseWriter, r *http.Request) {
	values, ok := readJSON(w, r, field{name: "email"})
	if !ok {
		return
	}
	p, err := principal(r)
	if err != nil {
		h.fail(w, r, "link google failed")
		return
	}
	raw := httpx.PathParam(r, "username")
	email, outcome, err := h.Identity.LinkGoogle(r.Context(), p, raw, values[0])
	if err != nil {
		h.fail(w, r, "link google failed")
		return
	}
	if outcome != "" {
		refusal := linkErrors[outcome]
		httpx.WriteError(w, refusal.status, refusal.detail)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, googleLinked{true, normalized(raw), email})
}
