// Package http is the Go port of apps/api/src/contexts/tenancy/http/tenancy-middleware.ts and
// of the read-only scope route: it resolves the project of every authenticated request and
// refuses requests that name another one, before any handler runs.
package http

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"math"
	"net/http"
	"regexp"
	"strconv"
	"strings"

	identityhttp "github.com/Dreamcoder08/sipges/apps/api-go/internal/identity/http"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/database"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/httpx"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/tenancy/domain"
)

// ScopeCookie is the project cookie of cookies.ts.
const ScopeCookie = "sipges_scope"

// The bodies of the TypeScript API, byte for byte.
const (
	ChooseProjectDetail = "Seleccione un proyecto autorizado mediante X-SIPGES-Scope o /select-project"
	OutOfScopeDetail    = "Proyecto fuera de alcance"
	OtherProjectDetail  = "No se permite escribir en otro proyecto"
)

// scopeFreePaths are global directory operations and personal MFA enrolment: authenticated and
// role-checked, but not business-scope writes. Enrolment must work before any grant (ADR 0009).
var scopeFreePaths = map[string]bool{
	"/system/auth/scopes":      true,
	"/system/auth/grants":      true,
	"/system/auth/totp/setup":  true,
	"/system/auth/totp/enable": true,
}

var accountDeactivation = regexp.MustCompile(`^/system/auth/accounts/[^/]+/(deactivate|google)$`)

var bodyCheckedMethods = map[string]bool{http.MethodPost: true, http.MethodPut: true, http.MethodPatch: true}

// GrantSource returns a user's grants; application.GrantCache satisfies it.
type GrantSource interface {
	Get(ctx context.Context, username string) ([]domain.Grant, error)
}

type scopeKey struct{}

// ScopeFrom returns the project the request was resolved to.
func ScopeFrom(ctx context.Context) (domain.Scope, bool) {
	s, ok := ctx.Value(scopeKey{}).(domain.Scope)
	return s, ok
}

// WithScope returns ctx carrying s, for tests.
func WithScope(ctx context.Context, s domain.Scope) context.Context {
	return context.WithValue(ctx, scopeKey{}, s)
}

type chooseProject struct {
	Detail   string   `json:"detail"`
	Projects []string `json:"projects"`
}

// Middleware is tenancyMiddleware (app.py enforce_auth steps 4-7): it resolves the authorized
// scope, then refuses a query or JSON body that names another project. It runs after
// identity's Session and before its RoleGate.
func Middleware(grants GrantSource, log *slog.Logger) httpx.Middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			principal, ok := identityhttp.PrincipalFrom(r.Context())
			path := r.URL.Path
			if !ok || scopeFreePaths[path] || accountDeactivation.MatchString(path) {
				next.ServeHTTP(w, r)
				return
			}

			granted, err := grants.Get(r.Context(), principal.Username)
			if err != nil {
				if log != nil {
					log.LogAttrs(r.Context(), slog.LevelError, "grant lookup failed",
						slog.String("request_id", httpx.RequestIDFrom(r.Context())))
				}
				httpx.WriteError(w, http.StatusInternalServerError, "Internal Server Error")
				return
			}
			header, _ := httpx.Header(r, "X-SIPGES-Scope")
			cookie, _ := httpx.Cookie(r, ScopeCookie)
			scope, ok := domain.ResolveScope(header, cookie, granted)
			if !ok {
				projects := make([]string, 0, len(granted))
				for _, g := range granted {
					projects = append(projects, g.TenantID())
				}
				httpx.WriteJSON(w, http.StatusForbidden, chooseProject{Detail: ChooseProjectDetail, Projects: projects})
				return
			}

			if requested, _ := httpx.QueryParam(r, "project_id"); requested != "" && requested != scope.ProjectID {
				httpx.WriteError(w, http.StatusForbidden, OutOfScopeDetail)
				return
			}

			contentType, _ := httpx.Header(r, "Content-Type")
			if bodyCheckedMethods[r.Method] && strings.HasPrefix(contentType, "application/json") &&
				(strings.HasPrefix(path, "/api/") || strings.HasPrefix(path, "/system/")) {
				body, readErr := io.ReadAll(r.Body)
				r.Body = io.NopCloser(bytes.NewReader(body)) // the handler reads it again
				if readErr != nil {
					body = nil // like Hono: a body that cannot be read counts as {}
				}
				if supplied, found := projectFromBody(body); found && !isString(supplied, scope.ProjectID) {
					httpx.WriteError(w, http.StatusForbidden, OtherProjectDetail)
					return
				}
			}

			next.ServeHTTP(w, r.WithContext(WithScope(r.Context(), scope)))
		})
	}
}

// projectFromBody is projectFromBody: the first truthy of body.project_id,
// body.payload.Proyecto_ID and body.payload.project_id, with JavaScript truthiness. found is
// false when none is truthy or the body is not a JSON object.
func projectFromBody(body []byte) (any, bool) {
	parsed := parseJSON(body)
	if _, deep := parsed.(tooDeep); deep {
		return parsed, true // never equal to a project id: refused
	}
	record, ok := parsed.(map[string]any)
	if !ok {
		return nil, false
	}
	payload, _ := record["payload"].(map[string]any) // an array payload has no such fields
	for _, v := range []any{record["project_id"], payload["Proyecto_ID"], payload["project_id"]} {
		if truthy(v) {
			return v, true
		}
	}
	return nil, false
}

// tooDeep marks a body nested beyond encoding/json's limit.
type tooDeep struct{}

// parseJSON is Hono's c.req.json() as the middleware uses it: Response.text() (which drops a
// UTF-8 byte order mark), then JSON.parse of the whole text; anything unparseable is {}.
func parseJSON(body []byte) any {
	body = bytes.TrimPrefix(body, []byte("\xef\xbb\xbf"))
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.UseNumber() // JSON.parse reads 1e400 as Infinity, where float64 decoding fails
	var v any
	if err := dec.Decode(&v); err != nil {
		if strings.Contains(err.Error(), "exceeded max depth") {
			// JSON.parse reads far deeper bodies than encoding/json; refuse rather than read
			// such a body as {} and skip the check.
			return tooDeep{}
		}
		return map[string]any{}
	}
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		return map[string]any{} // trailing data: JSON.parse throws
	}
	return v
}

// truthy is JavaScript truthiness for decoded JSON values.
func truthy(v any) bool {
	switch x := v.(type) {
	case nil:
		return false
	case bool:
		return x
	case string:
		return x != ""
	case json.Number:
		f, _ := strconv.ParseFloat(string(x), 64) // out of range gives ±Inf or 0, as JavaScript
		return f != 0 && !math.IsNaN(f)
	default:
		return true // objects and arrays
	}
}

func isString(v any, want string) bool {
	s, ok := v.(string)
	return ok && s == want
}

type currentScope struct {
	CompanyID string `json:"company_id"`
	ProjectID string `json:"project_id"`
	Scope     string `json:"scope"`
}

// CurrentScope is GET /system/auth/current-scope.
func CurrentScope(w http.ResponseWriter, r *http.Request) {
	scope, ok := ScopeFrom(r.Context())
	if !ok {
		// Unreachable behind Middleware; refuse rather than answer for no project.
		httpx.WriteError(w, http.StatusInternalServerError, "Internal Server Error")
		return
	}
	httpx.WriteJSON(w, http.StatusOK, currentScope{CompanyID: scope.CompanyID, ProjectID: scope.ProjectID, Scope: scope.TenantID()})
}

// ErrNoScope is returned by WithRequestTenant outside a resolved request.
var ErrNoScope = errors.New("tenancy: the request has no resolved project")

// WithRequestTenant runs fn in a tenant transaction for the request's resolved project, as the
// session's actor with its role's clearance (both set by the middleware chain).
func WithRequestTenant[T any](r *http.Request, db database.Beginner, fn func(context.Context, database.Querier) (T, error)) (T, error) {
	scope, ok := ScopeFrom(r.Context())
	if !ok {
		var zero T
		return zero, ErrNoScope
	}
	return database.WithTenant(r.Context(), db, scope.TenantID(), fn)
}
