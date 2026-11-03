// Package http is the Go port of apps/api/src/contexts/identity/http/auth-middleware.ts: the
// session check every route sits behind, and the role gate that runs after the project scope.
package http

import (
	"context"
	"log/slog"
	"net/http"
	"strings"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/identity/domain"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/database"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/httpx"
)

// SessionCookie is the session cookie of cookies.ts.
const SessionCookie = "sipges_session"

// The bodies of the TypeScript API, byte for byte.
const (
	SignInDetail      = "Inicie sesión para acceder a SIPGES"
	MFARequiredDetail = "Active la verificación en dos pasos (MFA) con /system/auth/totp/setup antes de continuar"
)

// publicPaths are reachable without a session (app.py enforce_auth exemptions, minus ADR 0008
// #4). Public routes still get the Origin check on writes.
var publicPaths = map[string]bool{
	"/health":                true,
	"/health/ready":          true,
	"/login":                 true,
	"/logout":                true,
	"/select-project":        true,
	"/system/auth/me":        true,
	"/system/auth/providers": true,
	"/auth/google":           true,
	"/auth/google/callback":  true,
}

// isMachinePath: machine endpoints authenticate with a bearer credential of their own (cron
// secret, API key) and never with the session cookie, so neither the session nor the Origin
// check applies (ADR 0014 §4, §6). The Go API serves none of them yet: they answer its 404.
func isMachinePath(path string) bool {
	return path == "/system/automations/cron" || path == "/mcp" || strings.HasPrefix(path, "/hooks/")
}

// mfaEnrollmentPaths are the only routes a session without a second factor may use (ADR 0009).
var mfaEnrollmentPaths = map[string]bool{
	"/system/auth/totp/setup":  true,
	"/system/auth/totp/enable": true,
}

// Authenticator verifies a session token; infrastructure.Sessions satisfies it.
type Authenticator interface {
	Authenticate(ctx context.Context, token string) (*domain.Principal, error)
}

type principalKey struct{}

// PrincipalFrom returns the identity of the request's session, if it had one.
func PrincipalFrom(ctx context.Context) (*domain.Principal, bool) {
	p, ok := ctx.Value(principalKey{}).(*domain.Principal)
	return p, ok
}

// WithPrincipal returns ctx carrying p, for handlers and tests.
func WithPrincipal(ctx context.Context, p *domain.Principal) context.Context {
	return context.WithValue(ctx, principalKey{}, p)
}

// SessionOptions configures Session.
type SessionOptions struct {
	Sessions   Authenticator
	RequireMFA bool
	Logger     *slog.Logger
}

// Session is sessionMiddleware (app.py enforce_auth steps 1-3): public routes, the session,
// the Origin check on writes and, with RequireMFA, TOTP enrolment before anything else. It must
// run after httpx.CanonicalPath so it reads the path the router dispatches on.
func Session(opts SessionOptions) httpx.Middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			path := r.URL.Path
			write := httpx.IsWriteMethod(r.Method)
			if isMachinePath(path) {
				next.ServeHTTP(w, r)
				return
			}
			if publicPaths[path] {
				if write && !httpx.OriginAllowed(r) {
					httpx.ForbiddenOrigin(w)
					return
				}
				next.ServeHTTP(w, r)
				return
			}

			token, _ := httpx.Cookie(r, SessionCookie)
			principal, err := opts.Sessions.Authenticate(r.Context(), token)
			if err != nil {
				if opts.Logger != nil {
					opts.Logger.LogAttrs(r.Context(), slog.LevelError, "session lookup failed",
						slog.String("request_id", httpx.RequestIDFrom(r.Context())))
				}
				httpx.WriteError(w, http.StatusInternalServerError, "Internal Server Error")
				return
			}
			if principal == nil {
				httpx.WriteError(w, http.StatusUnauthorized, SignInDetail)
				return
			}
			if write && !httpx.OriginAllowed(r) {
				httpx.ForbiddenOrigin(w)
				return
			}
			if opts.RequireMFA && !principal.MFAEnabled && !mfaEnrollmentPaths[path] {
				httpx.WriteJSON(w, http.StatusForbidden, mfaRequired{Detail: MFARequiredDetail, MFARequired: true})
				return
			}

			ctx := WithPrincipal(r.Context(), principal)
			ctx = database.WithActor(ctx, database.Actor{
				Name:      principal.Username,
				Clearance: database.Clearance(domain.Clearance(principal.Role)),
			})
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

type mfaRequired struct {
	Detail      string `json:"detail"`
	MFARequired bool   `json:"mfa_required"`
}

// RoleGate is roleGate (app.py enforce_auth step 8): evaluated after the project scope.
func RoleGate() httpx.Middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			principal, ok := PrincipalFrom(r.Context())
			if !ok {
				next.ServeHTTP(w, r)
				return
			}
			if d := domain.CheckRoleAccess(principal.Role, r.Method, r.URL.Path); !d.Allowed {
				httpx.WriteError(w, http.StatusForbidden, d.Detail)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}
