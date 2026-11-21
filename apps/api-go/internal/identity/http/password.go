package http

import (
	"context"
	"net/http"
	"strconv"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/identity/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/httpx"
)

// changePassword is POST /system/auth/password: the signed-in person replaces their own password.
// A wrong current password answers the login's generic refusal and counts toward its throttle; a
// weak new one answers which rule it broke. Like the login, the change is detached from the
// client, so an abort cannot fall between the throttle reservation and its release.
func (h authHandlers) changePassword(w http.ResponseWriter, r *http.Request) {
	values, ok := readJSON(w, r, field{name: "current_password"}, field{name: "new_password"})
	if !ok {
		return
	}
	p, err := principal(r)
	tenantID, scoped := h.TenantOf(r)
	if err != nil || !scoped {
		h.fail(w, r, "password change failed")
		return
	}
	token, _ := httpx.Cookie(r, SessionCookie)
	ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), loginTimeout)
	defer cancel()
	result, err := h.Identity.ChangePassword(ctx, p, token, application.PasswordChange{
		Current: values[0],
		New:     values[1],
		IP:      httpx.ClientIP(r, h.ClientIP),
	}, tenantID)
	switch {
	case err != nil:
		h.fail(w, r, "password change failed")
	case result.Failure == application.PasswordThrottled:
		w.Header().Set("Retry-After", strconv.Itoa(result.RetryAfterSeconds))
		httpx.WriteError(w, http.StatusTooManyRequests, loginDetails[application.Throttled])
	case result.Failure == application.PasswordWrongCurrent:
		httpx.WriteError(w, http.StatusBadRequest, loginDetails[application.InvalidCredentials])
	case result.Failure == application.PasswordRejected:
		httpx.WriteError(w, http.StatusUnprocessableEntity, result.Detail)
	default:
		w.WriteHeader(http.StatusNoContent)
	}
}
