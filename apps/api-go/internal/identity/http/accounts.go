package http

import (
	"errors"
	"net/http"
	"time"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/identity/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/identity/domain"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/httpx"
)

// accountErrors are the refusal tables of auth-routes.ts, byte for byte.
var accountErrors = map[application.AccountOutcome]struct {
	status int
	detail string
}{
	application.AccountForbidden:  {http.StatusForbidden, "Administración de cuentas restringida"},
	application.AccountSelf:       {http.StatusForbidden, "No puede restablecer su propio MFA; pida a otro administrador"},
	application.AccountOutOfScope: {http.StatusForbidden, "Usuario fuera del proyecto activo"},
	application.AccountInvalid:    {http.StatusUnprocessableEntity, "Usuario inválido"},
	application.AccountMissing:    {http.StatusNotFound, "Usuario inexistente"},
	application.AccountLastAdmin:  {http.StatusConflict, "No se permite desactivar el último administrador"},
}

type okResponse struct {
	OK bool `json:"ok"`
}

type accountSummary struct {
	Username    string  `json:"username"`
	FullName    string  `json:"full_name"`
	Role        string  `json:"role"`
	Active      int     `json:"active"`
	CreatedAt   string  `json:"created_at"`
	GoogleEmail *string `json:"google_email"`
}

type accountCreated struct {
	OK       bool   `json:"ok"`
	Username string `json:"username"`
	Role     string `json:"role"`
}

type accountReset struct {
	OK       bool   `json:"ok"`
	Username string `json:"username"`
}

// clearAuthCookies is clearAuthCookie of both cookies, session first.
func (h authHandlers) clearAuthCookies(w http.ResponseWriter) {
	w.Header().Add("Set-Cookie", httpx.AuthCookie(SessionCookie, "", h.CookieSecure, 0))
	w.Header().Add("Set-Cookie", httpx.AuthCookie(scopeCookie, "", h.CookieSecure, 0))
}

// logout is POST /logout: a public path, so it reads the cookie itself.
func (h authHandlers) logout(w http.ResponseWriter, r *http.Request) {
	token, _ := httpx.Cookie(r, SessionCookie)
	if err := h.Identity.Logout(r.Context(), token); err != nil {
		h.fail(w, r, "logout failed")
		return
	}
	h.clearAuthCookies(w)
	httpx.WriteJSON(w, http.StatusOK, okResponse{true})
}

// isoSeconds is time.ts: ISO 8601 UTC without fractional seconds.
func isoSeconds(at time.Time) string { return at.UTC().Format("2006-01-02T15:04:05Z") }

// listAccounts is GET /system/auth/accounts; the role gate already ran.
func (h authHandlers) listAccounts(w http.ResponseWriter, r *http.Request) {
	accounts, err := h.Identity.ListAccounts(r.Context())
	if err != nil {
		h.fail(w, r, "list accounts failed")
		return
	}
	out := make([]accountSummary, len(accounts))
	for i, a := range accounts {
		out[i] = accountSummary{Username: a.Username, FullName: a.FullName, Role: string(a.Role), CreatedAt: isoSeconds(a.CreatedAt), GoogleEmail: a.GoogleEmail}
		if a.Active {
			out[i].Active = 1
		}
	}
	httpx.WriteJSON(w, http.StatusOK, out)
}

// createAccount is POST /system/auth/accounts.
func (h authHandlers) createAccount(w http.ResponseWriter, r *http.Request) {
	consulta := string(domain.RoleReadOnly)
	values, ok := readJSON(w, r, field{name: "username"}, field{name: "full_name"}, field{name: "password"},
		field{name: "role", defaultValue: &consulta})
	if !ok {
		return
	}
	result, err := h.Identity.CreateAccount(r.Context(), domain.NewAccount{
		Username: values[0], FullName: values[1], Password: values[2], Role: values[3],
	})
	switch {
	case err != nil:
		h.fail(w, r, "create account failed")
	case result.Invalid != "":
		httpx.WriteError(w, http.StatusUnprocessableEntity, result.Invalid)
	case result.Exists:
		httpx.WriteError(w, http.StatusConflict, "Usuario existente")
	default:
		httpx.WriteJSON(w, http.StatusOK, accountCreated{true, result.Account.Username, result.Account.Role})
	}
}

var errNoPrincipal = errors.New("no principal behind a session route")

// answerAccount writes a refusal or reports whether the write succeeded.
func (h authHandlers) answerAccount(w http.ResponseWriter, r *http.Request, outcome application.AccountOutcome, err error, event string) bool {
	if err != nil {
		h.fail(w, r, event)
		return false
	}
	if outcome != "" {
		refusal := accountErrors[outcome]
		httpx.WriteError(w, refusal.status, refusal.detail)
		return false
	}
	return true
}

func principal(r *http.Request) (*domain.Principal, error) {
	p, ok := PrincipalFrom(r.Context())
	if !ok || p == nil {
		return nil, errNoPrincipal
	}
	return p, nil
}

// deactivateAccount is POST /system/auth/accounts/:username/deactivate. Deactivating oneself
// also clears one's cookies.
func (h authHandlers) deactivateAccount(w http.ResponseWriter, r *http.Request) {
	p, err := principal(r)
	if err != nil {
		h.fail(w, r, "deactivate account failed")
		return
	}
	raw := httpx.PathParam(r, "username")
	outcome, err := h.Identity.DeactivateAccount(r.Context(), p, raw)
	if !h.answerAccount(w, r, outcome, err, "deactivate account failed") {
		return
	}
	if domain.NormalizeUsername(raw) == p.Username {
		h.clearAuthCookies(w)
	}
	httpx.WriteJSON(w, http.StatusOK, okResponse{true})
}

// resetMFA is POST /system/auth/accounts/:username/reset-mfa, within the active project.
func (h authHandlers) resetMFA(w http.ResponseWriter, r *http.Request) {
	p, err := principal(r)
	tenantID, scoped := h.TenantOf(r)
	if err != nil || !scoped {
		h.fail(w, r, "reset mfa failed")
		return
	}
	raw := httpx.PathParam(r, "username")
	outcome, err := h.Identity.ResetMFA(r.Context(), p, raw, tenantID)
	if !h.answerAccount(w, r, outcome, err, "reset mfa failed") {
		return
	}
	httpx.WriteJSON(w, http.StatusOK, accountReset{true, normalized(raw)})
}

func normalized(raw string) string { return domain.NormalizeUsername(raw) }
