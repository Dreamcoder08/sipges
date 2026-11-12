package http

import (
	"net/http"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/httpx"
)

// sessionSummary is SessionSummary of packages/contracts (identity.ts).
type sessionSummary struct {
	ID        string `json:"id"`
	CreatedAt string `json:"created_at"`
	ExpiresAt string `json:"expires_at"`
	Method    string `json:"method"`
	Current   bool   `json:"current"`
}

type sessionList struct {
	Sessions []sessionSummary `json:"sessions"`
}

type sessionEnded struct {
	OK      bool `json:"ok"`
	Current bool `json:"current"`
}

type sessionsRevoked struct {
	OK    bool `json:"ok"`
	Count int  `json:"count"`
}

const sessionMissing = "Sesión inexistente"

// listSessions is GET /system/auth/sessions: the caller's own sessions only.
func (h authHandlers) listSessions(w http.ResponseWriter, r *http.Request) {
	p, err := principal(r)
	if err != nil {
		h.fail(w, r, "list sessions failed")
		return
	}
	token, _ := httpx.Cookie(r, SessionCookie)
	views, err := h.Identity.ListSessions(r.Context(), p.Username, token)
	if err != nil {
		h.fail(w, r, "list sessions failed")
		return
	}
	out := sessionList{Sessions: make([]sessionSummary, len(views))}
	for i, v := range views {
		method := "password"
		if v.ViaGoogle {
			method = "google"
		}
		out.Sessions[i] = sessionSummary{v.ID, isoSeconds(v.CreatedAt), isoSeconds(v.ExpiresAt), method, v.Current}
	}
	httpx.WriteJSON(w, http.StatusOK, out)
}

// endSession is DELETE /system/auth/sessions/:id; ending this device's session is a logout.
func (h authHandlers) endSession(w http.ResponseWriter, r *http.Request) {
	p, err := principal(r)
	tenantID, scoped := h.TenantOf(r)
	if err != nil || !scoped {
		h.fail(w, r, "end session failed")
		return
	}
	token, _ := httpx.Cookie(r, SessionCookie)
	found, current, err := h.Identity.EndSession(r.Context(), p, token, httpx.PathParam(r, "id"), tenantID)
	switch {
	case err != nil:
		h.fail(w, r, "end session failed")
	case !found:
		httpx.WriteError(w, http.StatusNotFound, sessionMissing)
	default:
		if current {
			h.clearAuthCookies(w)
		}
		httpx.WriteJSON(w, http.StatusOK, sessionEnded{true, current})
	}
}

// revokeOtherSessions is POST /system/auth/sessions/revoke-others.
func (h authHandlers) revokeOtherSessions(w http.ResponseWriter, r *http.Request) {
	p, err := principal(r)
	tenantID, scoped := h.TenantOf(r)
	if err != nil || !scoped {
		h.fail(w, r, "revoke other sessions failed")
		return
	}
	token, _ := httpx.Cookie(r, SessionCookie)
	count, err := h.Identity.EndOtherSessions(r.Context(), p, token, tenantID)
	if err != nil {
		h.fail(w, r, "revoke other sessions failed")
		return
	}
	httpx.WriteJSON(w, http.StatusOK, sessionsRevoked{true, count})
}
