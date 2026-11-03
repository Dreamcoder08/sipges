// Package identityhttp is the HTTP side of identity in the Go API: the session middleware
// (auth-middleware.ts sessionMiddleware), the role gate, and GET /system/auth/me and
// /system/auth/providers. Messages and order are the TypeScript API's.
package identityhttp

import (
	"context"
	"log/slog"
	"net/http"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/identity/domain"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/database"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/httpx"
)

// SessionCookie is the session cookie's name (platform/http/cookies.ts).
const SessionCookie = "sipges_session"

// Authenticator resolves a session token (application.Service).
type Authenticator interface {
	Authenticate(ctx context.Context, token string) (*domain.Principal, error)
}

type principalKey struct{}

// PrincipalFrom returns the signed-in user the session middleware attached, or nil.
func PrincipalFrom(ctx context.Context) *domain.Principal {
	p, _ := ctx.Value(principalKey{}).(*domain.Principal)
	return p
}

// internalError answers the TypeScript API's 500. Only a fixed kind is logged: driver
// messages may carry connection details.
func internalError(w http.ResponseWriter, r *http.Request, log *slog.Logger) {
	log.Error("unhandled_error", slog.String("request_id", httpx.RequestIDFrom(r.Context())),
		slog.String("method", r.Method), slog.String("path", r.URL.Path), slog.String("error", "store_error"))
	httpx.WriteError(w, http.StatusInternalServerError, "Internal Server Error")
}

// Session is sessionMiddleware: machine paths pass; public paths pass after the Origin check on
// writes; anything else needs a valid session, then the Origin check on writes, then (with
// requireMFA) an enrolled second factor. It attaches the principal and the database actor.
func Session(auth Authenticator, requireMFA bool, log *slog.Logger) httpx.Middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			path := r.URL.Path
			write := httpx.IsWriteMethod(r.Method)
			if domain.IsMachinePath(path) {
				next.ServeHTTP(w, r)
				return
			}
			if domain.IsPublicPath(path) {
				if write && !httpx.OriginAllowed(r) {
					httpx.WriteError(w, http.StatusForbidden, "Origen de solicitud no permitido")
					return
				}
				next.ServeHTTP(w, r)
				return
			}
			token, _ := httpx.Cookie(r, SessionCookie)
			principal, err := auth.Authenticate(r.Context(), token)
			if err != nil {
				internalError(w, r, log)
				return
			}
			if principal == nil || token == "" {
				httpx.WriteError(w, http.StatusUnauthorized, "Inicie sesión para acceder a SIPGES")
				return
			}
			if write && !httpx.OriginAllowed(r) {
				httpx.WriteError(w, http.StatusForbidden, "Origen de solicitud no permitido")
				return
			}
			if requireMFA && !principal.MFAEnabled && !domain.IsMFAEnrollmentPath(path) {
				httpx.WriteJSON(w, http.StatusForbidden, struct {
					Detail      string `json:"detail"`
					MFARequired bool   `json:"mfa_required"`
				}{domain.MFARequiredDetail, true})
				return
			}
			ctx := context.WithValue(r.Context(), principalKey{}, principal)
			ctx = database.WithActor(ctx, database.Actor{
				Name:      principal.Username,
				Clearance: database.Clearance(domain.ClearanceFor(principal.Role)),
			})
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

// RoleGate is roleGate (app.py step 8): it runs after tenancy resolved the scope.
func RoleGate() httpx.Middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if p := PrincipalFrom(r.Context()); p != nil {
				if d := domain.CheckRoleAccess(p.Role, r.Method, r.URL.Path); !d.Allowed {
					httpx.WriteError(w, http.StatusForbidden, d.Detail)
					return
				}
			}
			next.ServeHTTP(w, r)
		})
	}
}

// me is the Me contract of packages/contracts (identity.ts); active is always 1.
type me struct {
	Username string `json:"username"`
	FullName string `json:"full_name"`
	Role     string `json:"role"`
	Active   int    `json:"active"`
}

// Routes registers GET /system/auth/me (null without a valid session) and
// GET /system/auth/providers ({"google": …}). Both are public paths.
func Routes(mux *http.ServeMux, auth Authenticator, googleEnabled bool, log *slog.Logger) {
	mux.HandleFunc("GET /system/auth/me", func(w http.ResponseWriter, r *http.Request) {
		token, _ := httpx.Cookie(r, SessionCookie)
		p, err := auth.Authenticate(r.Context(), token)
		if err != nil {
			internalError(w, r, log)
			return
		}
		if p == nil {
			httpx.WriteJSON(w, http.StatusOK, nil)
			return
		}
		httpx.WriteJSON(w, http.StatusOK, me{p.Username, p.FullName, string(p.Role), 1})
	})
	mux.HandleFunc("GET /system/auth/providers", func(w http.ResponseWriter, _ *http.Request) {
		httpx.WriteJSON(w, http.StatusOK, struct {
			Google bool `json:"google"`
		}{googleEnabled})
	})
}
