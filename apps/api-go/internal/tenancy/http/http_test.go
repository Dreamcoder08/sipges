package tenancyhttp_test

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/tenancy/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/tenancy/domain"
	tenancyhttp "github.com/Dreamcoder08/sipges/apps/api-go/internal/tenancy/http"
)

type grants map[string][]domain.Scope

func (g grants) ListGrants(_ context.Context, u string) ([]domain.Scope, error) { return g[u], nil }

var (
	a     = domain.Scope{CompanyID: "SIPGES", ProjectID: "PRJ-A"}
	b     = domain.Scope{CompanyID: "SIPGES", ProjectID: "PRJ-B"}
	quiet = slog.New(slog.NewTextHandler(io.Discard, nil))
)

// userHeader stands in for the session middleware.
func user(r *http.Request) (string, bool) {
	u := r.Header.Get("X-Test-User")
	return u, u != ""
}

func reached(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(r.Body)
	out := map[string]any{"reached": true, "body": string(body)}
	if s, ok := tenancyhttp.ScopeFrom(r.Context()); ok {
		out["scope"] = s.String()
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(out)
}

func TestTenancyMiddleware(t *testing.T) {
	t.Parallel()
	svc := application.NewService(grants{"one": {a}, "two": {a, b}}, time.Now)
	h := tenancyhttp.Tenancy(svc, user, quiet)(http.HandlerFunc(reached))
	choose := map[string]any{
		"detail":   "Seleccione un proyecto autorizado mediante X-SIPGES-Scope o /select-project",
		"projects": []any{"SIPGES/PRJ-A", "SIPGES/PRJ-B"},
	}
	cases := []struct {
		name, method, target, user, body, contentType string
		headers                                       map[string]string
		status                                        int
		want                                          map[string]any
	}{
		{name: "no principal passes", method: "GET", target: "/system/x", status: 200, want: map[string]any{"reached": true, "body": ""}},
		{name: "scope-free path", method: "GET", target: "/system/auth/scopes", user: "two", status: 200, want: map[string]any{"reached": true, "body": ""}},
		{name: "reset-mfa needs a project, as in tenancy-middleware.ts", method: "POST", target: "/system/auth/accounts/ana/reset-mfa", user: "two", status: 403, want: choose},
		{name: "encoded project_id key", method: "GET", target: "/system/x?project%5Fid=PRJ-B", user: "one", status: 403, want: map[string]any{"detail": "Proyecto fuera de alcance"}},
		{name: "account deactivation is scope-free", method: "POST", target: "/system/auth/accounts/ana/deactivate", user: "two", status: 200, want: map[string]any{"reached": true, "body": ""}},
		{name: "single grant is selected", method: "GET", target: "/system/x", user: "one", status: 200, want: map[string]any{"reached": true, "body": "", "scope": "SIPGES/PRJ-A"}},
		{name: "two grants need a choice", method: "GET", target: "/system/x", user: "two", status: 403, want: choose},
		{name: "no grants", method: "GET", target: "/system/x", user: "none", status: 403, want: map[string]any{"detail": choose["detail"], "projects": []any{}}},
		{name: "header chooses", method: "GET", target: "/system/x", user: "two", headers: map[string]string{"X-SIPGES-Scope": "SIPGES/PRJ-B"}, status: 200, want: map[string]any{"reached": true, "body": "", "scope": "SIPGES/PRJ-B"}},
		{name: "encoded cookie chooses", method: "GET", target: "/system/x", user: "two", headers: map[string]string{"Cookie": "sipges_scope=SIPGES%2FPRJ-B"}, status: 200, want: map[string]any{"reached": true, "body": "", "scope": "SIPGES/PRJ-B"}},
		{name: "project_id of another project", method: "GET", target: "/system/x?project_id=PRJ-B", user: "one", status: 403, want: map[string]any{"detail": "Proyecto fuera de alcance"}},
		{name: "undecodable project_id is still compared", method: "GET", target: "/system/x?project_id=%ZZ", user: "one", status: 403, want: map[string]any{"detail": "Proyecto fuera de alcance"}},
		{name: "own project_id", method: "GET", target: "/system/x?project_id=PRJ-A", user: "one", status: 200, want: map[string]any{"reached": true, "body": "", "scope": "SIPGES/PRJ-A"}},
		{name: "JSON body names another project", method: "POST", target: "/api/x", user: "one", body: `{"project_id":"PRJ-B"}`, contentType: "application/json", status: 403, want: map[string]any{"detail": "No se permite escribir en otro proyecto"}},
		{name: "JSON body of the own project stays readable", method: "PATCH", target: "/system/x", user: "one", body: `{"project_id":"PRJ-A"}`, contentType: "application/json; charset=utf-8", status: 200, want: map[string]any{"reached": true, "body": `{"project_id":"PRJ-A"}`, "scope": "SIPGES/PRJ-A"}},
		{name: "not JSON is not checked", method: "POST", target: "/api/x", user: "one", body: `{"project_id":"PRJ-B"}`, contentType: "text/plain", status: 200, want: map[string]any{"reached": true, "body": `{"project_id":"PRJ-B"}`, "scope": "SIPGES/PRJ-A"}},
		{name: "media type is case-sensitive like startsWith", method: "POST", target: "/api/x", user: "one", body: `{"project_id":"PRJ-B"}`, contentType: "Application/JSON", status: 200, want: map[string]any{"reached": true, "body": `{"project_id":"PRJ-B"}`, "scope": "SIPGES/PRJ-A"}},
		{name: "DELETE body is not checked", method: "DELETE", target: "/api/x", user: "one", body: `{"project_id":"PRJ-B"}`, contentType: "application/json", status: 200, want: map[string]any{"reached": true, "body": `{"project_id":"PRJ-B"}`, "scope": "SIPGES/PRJ-A"}},
		{name: "paths outside /api and /system are not checked", method: "POST", target: "/select-x", user: "one", body: `{"project_id":"PRJ-B"}`, contentType: "application/json", status: 200, want: map[string]any{"reached": true, "body": `{"project_id":"PRJ-B"}`, "scope": "SIPGES/PRJ-A"}},
	}
	for _, c := range cases {
		r := httptest.NewRequest(c.method, c.target, strings.NewReader(c.body))
		if c.user != "" {
			r.Header.Set("X-Test-User", c.user)
		}
		if c.contentType != "" {
			r.Header.Set("Content-Type", c.contentType)
		}
		for k, v := range c.headers {
			r.Header.Set(k, v)
		}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		var got map[string]any
		_ = json.Unmarshal(w.Body.Bytes(), &got)
		if w.Code != c.status || !reflect.DeepEqual(got, c.want) {
			t.Errorf("%s: %d %v, want %d %v", c.name, w.Code, got, c.status, c.want)
		}
	}
}

func TestTenancyRefusesABodyItCannotRead(t *testing.T) {
	t.Parallel()
	svc := application.NewService(grants{"one": {a}}, time.Now)
	h := tenancyhttp.Tenancy(svc, user, quiet)(http.HandlerFunc(reached))
	body := `{"project_id":"PRJ-B","x":` + strings.Repeat("[", 10001) + strings.Repeat("]", 10001) + `}`
	r := httptest.NewRequest(http.MethodPost, "/api/x", strings.NewReader(body))
	r.Header.Set("X-Test-User", "one")
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	var got map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &got)
	if w.Code != http.StatusBadRequest || !reflect.DeepEqual(got, map[string]any{"detail": "Cuerpo JSON demasiado anidado"}) {
		t.Fatalf("%d %v", w.Code, got)
	}
}

func TestTenancyRefusesAnOversizedJSONBody(t *testing.T) {
	t.Parallel()
	svc := application.NewService(grants{"one": {a}}, time.Now)
	h := tenancyhttp.Tenancy(svc, user, quiet)(http.HandlerFunc(reached))
	r := httptest.NewRequest(http.MethodPost, "/api/x", strings.NewReader(`{"x":"`+strings.Repeat("a", tenancyhttp.MaxCheckedBody)+`"}`))
	r.Header.Set("X-Test-User", "one")
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status %d", w.Code)
	}
}
