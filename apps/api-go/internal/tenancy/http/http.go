// Package tenancyhttp is tenancy-middleware.ts in Go: after the session middleware it resolves
// the request's project from the user's grants and refuses requests that name another project
// in the query (project_id) or in a JSON body. Messages and order are the TypeScript API's.
package tenancyhttp

import (
	"bytes"
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"regexp"
	"slices"
	"strings"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/httpx"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/tenancy/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/tenancy/domain"
)

// ScopeCookie is the project cookie's name (platform/http/cookies.ts).
const ScopeCookie = "sipges_scope"

// MaxCheckedBody bounds the JSON body read for the project check. The TypeScript API has no
// global limit; this is the one deliberate difference (413 instead of reading without bound).
const MaxCheckedBody = 32 << 20

// scopeFreePaths are authenticated and role-checked but need no project (ADR 0009).
var scopeFreePaths = []string{
	"/system/auth/scopes", "/system/auth/grants", "/system/auth/totp/setup", "/system/auth/totp/enable",
}

var accountAction = regexp.MustCompile(`^/system/auth/accounts/[^/]+/(deactivate|reset-mfa|google)$`)

type scopeKey struct{}

// ScopeFrom returns the scope the middleware resolved for this request.
func ScopeFrom(ctx context.Context) (domain.Scope, bool) {
	s, ok := ctx.Value(scopeKey{}).(domain.Scope)
	return s, ok
}

// Username returns the signed-in user of a request, if any (the session middleware's principal).
type Username func(r *http.Request) (string, bool)

type chooseProject struct {
	Detail   string   `json:"detail"`
	Projects []string `json:"projects"`
}

// Tenancy is tenancyMiddleware.
func Tenancy(svc *application.Service, username Username, log *slog.Logger) httpx.Middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			user, ok := username(r)
			path := r.URL.Path
			if !ok || slices.Contains(scopeFreePaths, path) || accountAction.MatchString(path) {
				next.ServeHTTP(w, r)
				return
			}
			cookie, _ := httpx.Cookie(r, ScopeCookie)
			res, err := svc.Resolve(r.Context(), user, httpx.HeaderValue(r, "X-SIPGES-Scope"), cookie)
			if err != nil {
				log.Error("unhandled_error", slog.String("request_id", httpx.RequestIDFrom(r.Context())),
					slog.String("method", r.Method), slog.String("path", path), slog.String("error", "store_error"))
				httpx.WriteError(w, http.StatusInternalServerError, "Internal Server Error")
				return
			}
			if res.Scope == nil {
				httpx.WriteJSON(w, http.StatusForbidden, chooseProject{
					Detail:   "Seleccione un proyecto autorizado mediante X-SIPGES-Scope o /select-project",
					Projects: res.Projects,
				})
				return
			}
			scope := *res.Scope
			if requested := httpx.QueryParam(r, "project_id"); requested != "" && requested != scope.ProjectID {
				httpx.WriteError(w, http.StatusForbidden, "Proyecto fuera de alcance")
				return
			}
			if checksBody(r) {
				body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, MaxCheckedBody))
				var tooLarge *http.MaxBytesError
				if errors.As(err, &tooLarge) {
					httpx.WriteError(w, http.StatusRequestEntityTooLarge, "Payload Too Large")
					return
				}
				// A body that cannot be read counts as {} (c.req.json() failing in TypeScript).
				if err == nil && domain.BodyNamesOtherProject(body, scope.ProjectID) {
					httpx.WriteError(w, http.StatusForbidden, "No se permite escribir en otro proyecto")
					return
				}
				r.Body = io.NopCloser(bytes.NewReader(body))
			}
			next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), scopeKey{}, scope)))
		})
	}
}

func checksBody(r *http.Request) bool {
	switch r.Method {
	case http.MethodPost, http.MethodPut, http.MethodPatch:
	default:
		return false
	}
	return strings.HasPrefix(httpx.HeaderValue(r, "Content-Type"), "application/json") &&
		(strings.HasPrefix(r.URL.Path, "/api/") || strings.HasPrefix(r.URL.Path, "/system/"))
}
