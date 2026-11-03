package identityhttp_test

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/identity/domain"
	identityhttp "github.com/Dreamcoder08/sipges/apps/api-go/internal/identity/http"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/database"
)

const token = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

type fakeAuth map[string]*domain.Principal

var errStore = errors.New("store down")

func (f fakeAuth) Authenticate(_ context.Context, t string) (*domain.Principal, error) {
	return f[t], nil
}

var (
	admin    = &domain.Principal{Username: "ana", FullName: "Ana", Role: "admin", MFAEnabled: true}
	noMFA    = &domain.Principal{Username: "beto", FullName: "Beto", Role: "consulta"}
	quiet    = slog.New(slog.NewTextHandler(io.Discard, nil))
	sessions = fakeAuth{token: admin, "b" + token[1:]: noMFA}
)

// reached answers 200 with what the pipeline put in the context.
func reached(w http.ResponseWriter, r *http.Request) {
	p := identityhttp.PrincipalFrom(r.Context())
	actor, _ := database.ActorFrom(r.Context())
	body := map[string]any{"reached": true}
	if p != nil {
		body["user"] = p.Username
		body["actor"] = actor.Name
		body["clearance"] = string(actor.Clearance)
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(body)
}

func serve(t *testing.T, h http.Handler, method, path string, headers map[string]string) (int, any) {
	t.Helper()
	r := httptest.NewRequest(method, "http://app.example"+path, nil)
	for k, v := range headers {
		r.Header.Set(k, v)
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	var body any
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("%s %s: body %q is not JSON", method, path, w.Body.String())
	}
	return w.Code, body
}

func detail(s string) map[string]any { return map[string]any{"detail": s} }

func TestSessionMiddleware(t *testing.T) {
	t.Parallel()
	pipeline := identityhttp.Session(sessions, true, quiet)(http.HandlerFunc(reached))
	cookie := map[string]string{"Cookie": "sipges_session=" + token}
	sameOrigin := map[string]string{"Cookie": "sipges_session=" + token, "Origin": "http://app.example"}
	cases := []struct {
		name         string
		method, path string
		headers      map[string]string
		status       int
		body         any
	}{
		{"machine path skips the session", "POST", "/hooks/feed", nil, 200, map[string]any{"reached": true}},
		{"public path without a session", "GET", "/system/auth/me", nil, 200, map[string]any{"reached": true}},
		{"public write needs the Origin", "POST", "/login", nil, 403, detail("Origen de solicitud no permitido")},
		{"public write with the Origin", "POST", "/login", map[string]string{"Origin": "http://app.example"}, 200, map[string]any{"reached": true}},
		{"no session", "GET", "/system/x", nil, 401, detail("Inicie sesión para acceder a SIPGES")},
		{"unknown token", "GET", "/system/x", map[string]string{"Cookie": "sipges_session=" + "f" + token[1:]}, 401, detail("Inicie sesión para acceder a SIPGES")},
		{"401 wins over the Origin check", "POST", "/system/x", nil, 401, detail("Inicie sesión para acceder a SIPGES")},
		{"write without Origin", "POST", "/system/x", cookie, 403, detail("Origen de solicitud no permitido")},
		{"write with Origin", "POST", "/system/x", sameOrigin, 200, map[string]any{"reached": true, "user": "ana", "actor": "ana", "clearance": "full"}},
		{"read", "GET", "/system/x", cookie, 200, map[string]any{"reached": true, "user": "ana", "actor": "ana", "clearance": "full"}},
		{"MFA required", "GET", "/system/x", map[string]string{"Cookie": "sipges_session=b" + token[1:]}, 403,
			map[string]any{"detail": domain.MFARequiredDetail, "mfa_required": true}},
		{"MFA enrolment stays open", "GET", "/system/auth/totp/setup", map[string]string{"Cookie": "sipges_session=b" + token[1:]}, 200,
			map[string]any{"reached": true, "user": "beto", "actor": "beto", "clearance": "limited"}},
	}
	for _, c := range cases {
		status, body := serve(t, pipeline, c.method, c.path, c.headers)
		if status != c.status || !reflect.DeepEqual(body, c.body) {
			t.Errorf("%s: %d %v, want %d %v", c.name, status, body, c.status, c.body)
		}
	}

	optional := identityhttp.Session(sessions, false, quiet)(http.HandlerFunc(reached))
	if status, _ := serve(t, optional, "GET", "/system/x", map[string]string{"Cookie": "sipges_session=b" + token[1:]}); status != 200 {
		t.Errorf("MFA not required: %d", status)
	}
	errAuth := identityhttp.Session(erroring{}, true, quiet)(http.HandlerFunc(reached))
	if status, body := serve(t, errAuth, "GET", "/system/x", cookie); status != 500 || !reflect.DeepEqual(body, detail("Internal Server Error")) {
		t.Errorf("store failure: %d %v", status, body)
	}
}

type erroring struct{}

func (erroring) Authenticate(context.Context, string) (*domain.Principal, error) {
	return nil, errStore
}

func TestRoleGate(t *testing.T) {
	t.Parallel()
	gate := identityhttp.Session(sessions, false, quiet)(identityhttp.RoleGate()(http.HandlerFunc(reached)))
	consulta := map[string]string{"Cookie": "sipges_session=b" + token[1:], "Origin": "http://app.example"}
	if status, body := serve(t, gate, "POST", "/api/eventos", consulta); status != 403 || !reflect.DeepEqual(body, detail("Rol de consulta: solo lectura")) {
		t.Errorf("consulta write: %d %v", status, body)
	}
	if status, _ := serve(t, gate, "GET", "/api/eventos", consulta); status != 200 {
		t.Errorf("consulta read: %d", status)
	}
	if status, _ := serve(t, gate, "GET", "/system/auth/me", nil); status != 200 {
		t.Errorf("public path without principal: %d", status)
	}
}

func TestRoutes(t *testing.T) {
	t.Parallel()
	for _, google := range []bool{false, true} {
		mux := http.NewServeMux()
		identityhttp.Routes(mux, sessions, google, quiet)
		if status, body := serve(t, mux, "GET", "/system/auth/providers", nil); status != 200 || !reflect.DeepEqual(body, map[string]any{"google": google}) {
			t.Errorf("providers(google=%v): %d %v", google, status, body)
		}
		if status, body := serve(t, mux, "GET", "/system/auth/me", nil); status != 200 || body != nil {
			t.Errorf("me without session: %d %v", status, body)
		}
		want := map[string]any{"username": "ana", "full_name": "Ana", "role": "admin", "active": float64(1)}
		if status, body := serve(t, mux, "GET", "/system/auth/me", map[string]string{"Cookie": "sipges_session=" + token}); status != 200 || !reflect.DeepEqual(body, want) {
			t.Errorf("me with session: %d %v", status, body)
		}
	}
	mux := http.NewServeMux()
	identityhttp.Routes(mux, erroring{}, false, quiet)
	if status, body := serve(t, mux, "GET", "/system/auth/me", map[string]string{"Cookie": "sipges_session=" + token}); status != 500 || !reflect.DeepEqual(body, detail("Internal Server Error")) {
		t.Errorf("me with a failing store: %d %v", status, body)
	}
}
