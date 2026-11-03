package http_test

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/reference/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/reference/domain"
	referencehttp "github.com/Dreamcoder08/sipges/apps/api-go/internal/reference/http"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/reference/infrastructure"
)

type scopeKey struct{}

func scopeFrom(ctx context.Context) (domain.Scope, bool) {
	s, ok := ctx.Value(scopeKey{}).(domain.Scope)
	return s, ok
}

func serve(t *testing.T, svc *application.Service, method, path string, scope *domain.Scope) (*httptest.ResponseRecorder, map[string]any) {
	t.Helper()
	mux := http.NewServeMux()
	referencehttp.Register(mux, svc, scopeFrom, slog.New(slog.NewTextHandler(io.Discard, nil)))
	req := httptest.NewRequest(method, path, nil)
	if scope != nil {
		req = req.WithContext(context.WithValue(req.Context(), scopeKey{}, *scope))
	}
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	var body map[string]any
	if method != http.MethodHead {
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Fatalf("%s %s: body %q: %v", method, path, rec.Body.String(), err)
		}
	}
	return rec, body
}

func embedded(t *testing.T) *application.Service {
	t.Helper()
	r, err := infrastructure.NewEmbeddedReader()
	if err != nil {
		t.Fatal(err)
	}
	return application.NewService(r)
}

var registered = domain.Scope{CompanyID: "SIPGES", ProjectID: "PRJ-SECHURA"}

func TestRoutesServeTheRegisteredTenant(t *testing.T) {
	svc := embedded(t)
	rec, body := serve(t, svc, http.MethodGet, "/system/project-coordinates", &registered)
	if rec.Code != http.StatusOK || rec.Header().Get("Content-Type") != "application/json" {
		t.Fatalf("status %d, type %q", rec.Code, rec.Header().Get("Content-Type"))
	}
	data, _ := body["data"].(map[string]any)
	if body["available"] != true || data["project_id"] != "PRJ-SECHURA" || body["notice"] != data["source"].(map[string]any)["scope"] {
		t.Fatalf("coordinates body %v", body)
	}
	rec, body = serve(t, svc, http.MethodGet, "/system/canonical-entities", &registered)
	if rec.Code != http.StatusOK || body["available"] != true || body["notice"] != application.EntitiesNotice {
		t.Fatalf("entities %d %v", rec.Code, body)
	}
	if _, ok := body["data"].(map[string]any)["CCSMS"]; !ok {
		t.Fatalf("entities data %v", body["data"])
	}
}

// Tenant isolation: another project, even of the same company, never sees the references.
func TestRoutesNeverServeAnotherTenant(t *testing.T) {
	svc := embedded(t)
	for _, other := range []domain.Scope{{CompanyID: "ACME", ProjectID: "NORTE"}, {CompanyID: "SIPGES", ProjectID: "NORTE"}} {
		rec, body := serve(t, svc, http.MethodGet, "/system/project-coordinates", &other)
		want := map[string]any{"available": false, "data": nil, "notice": application.NoCoordinatesNotice}
		if rec.Code != http.StatusOK || !equal(body, want) {
			t.Errorf("%v coordinates %d %v", other, rec.Code, body)
		}
		rec, body = serve(t, svc, http.MethodGet, "/system/canonical-entities", &other)
		want = map[string]any{"available": false, "data": nil, "notice": application.EntitiesNotice}
		if rec.Code != http.StatusOK || !equal(body, want) {
			t.Errorf("%v entities %d %v", other, rec.Code, body)
		}
	}
}

func TestHeadIsServedLikeGet(t *testing.T) {
	rec, _ := serve(t, embedded(t), http.MethodHead, "/system/canonical-entities", &registered)
	if rec.Code != http.StatusOK {
		t.Fatalf("HEAD status %d", rec.Code)
	}
}

type failing struct{}

func (failing) Coordinates(context.Context, domain.Scope) (*domain.ProjectCoordinates, error) {
	return nil, errors.New("postgres://secret@host")
}

func (failing) Entities(context.Context, domain.Scope) (domain.CanonicalEntities, error) {
	return nil, errors.New("postgres://secret@host")
}

// Hono's onError: a failure, or a request that reached the route without a scope, is the
// generic 500 and never echoes the cause.
func TestFailuresAreTheGeneric500(t *testing.T) {
	want := map[string]any{"detail": "Internal Server Error"}
	for _, path := range []string{"/system/project-coordinates", "/system/canonical-entities"} {
		rec, body := serve(t, application.NewService(failing{}), http.MethodGet, path, &registered)
		if rec.Code != http.StatusInternalServerError || !equal(body, want) {
			t.Errorf("%s reader failure: %d %v", path, rec.Code, body)
		}
		rec, body = serve(t, embedded(t), http.MethodGet, path, nil)
		if rec.Code != http.StatusInternalServerError || !equal(body, want) {
			t.Errorf("%s without scope: %d %v", path, rec.Code, body)
		}
	}
}

func equal(a, b map[string]any) bool {
	x, _ := json.Marshal(a)
	y, _ := json.Marshal(b)
	return string(x) == string(y)
}
