package http

import (
	"log/slog"
	"net/http"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/httpx"
)

// me is the Me contract of packages/contracts (identity.ts); active is always 1.
type me struct {
	Username string `json:"username"`
	FullName string `json:"full_name"`
	Role     string `json:"role"`
	Active   int    `json:"active"`
}

type providers struct {
	Google bool `json:"google"`
}

// Routes registers GET /system/auth/me (auth-routes.ts: the session's user, or null) and
// GET /system/auth/providers (google-routes.ts: whether Google sign-in is configured). Both
// are public paths: the session middleware lets them through without a session.
func Routes(mux *http.ServeMux, sessions Authenticator, googleEnabled bool, log *slog.Logger) {
	mux.HandleFunc("GET /system/auth/me", func(w http.ResponseWriter, r *http.Request) {
		token, _ := httpx.Cookie(r, SessionCookie)
		p, err := sessions.Authenticate(r.Context(), token)
		if err != nil {
			// Only the event: driver errors may carry connection details.
			if log != nil {
				log.LogAttrs(r.Context(), slog.LevelError, "session lookup failed",
					slog.String("request_id", httpx.RequestIDFrom(r.Context())))
			}
			httpx.WriteError(w, http.StatusInternalServerError, "Internal Server Error")
			return
		}
		if p == nil {
			httpx.WriteJSON(w, http.StatusOK, nil)
			return
		}
		httpx.WriteJSON(w, http.StatusOK, me{p.Username, p.FullName, string(p.Role), 1})
	})
	mux.HandleFunc("GET /system/auth/providers", func(w http.ResponseWriter, _ *http.Request) {
		httpx.WriteJSON(w, http.StatusOK, providers{googleEnabled})
	})
}
