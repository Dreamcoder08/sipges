package http_test

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
)

const token = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

type sessions map[string]*domain.Principal

func (s sessions) Authenticate(_ context.Context, t string) (*domain.Principal, error) {
	return s[t], nil
}

type failing struct{}

func (failing) Authenticate(context.Context, string) (*domain.Principal, error) {
	return nil, errors.New("store down: postgres://synthetic@db")
}

func get(t *testing.T, mux http.Handler, path, cookie string) (int, any) {
	t.Helper()
	r := httptest.NewRequest(http.MethodGet, path, nil)
	if cookie != "" {
		r.Header.Set("Cookie", cookie)
	}
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, r)
	var body any
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("%s: body %q is not JSON", path, w.Body.String())
	}
	return w.Code, body
}

// auth-routes.ts GET /system/auth/me and google-routes.ts GET /system/auth/providers.
func TestRoutes(t *testing.T) {
	t.Parallel()
	quiet := slog.New(slog.NewTextHandler(io.Discard, nil))
	ana := &domain.Principal{Username: "ana", FullName: "Ana Sintética", Role: "admin", MFAEnabled: true}
	for _, google := range []bool{false, true} {
		mux := http.NewServeMux()
		identityhttp.Routes(mux, sessions{token: ana}, google, quiet)
		if status, body := get(t, mux, "/system/auth/providers", ""); status != 200 || !reflect.DeepEqual(body, map[string]any{"google": google}) {
			t.Errorf("providers(google=%v): %d %v", google, status, body)
		}
		if status, body := get(t, mux, "/system/auth/me", ""); status != 200 || body != nil {
			t.Errorf("me without a session: %d %v", status, body)
		}
		if status, body := get(t, mux, "/system/auth/me", "sipges_session="+"f"+token[1:]); status != 200 || body != nil {
			t.Errorf("me with an unknown session: %d %v", status, body)
		}
		want := map[string]any{"username": "ana", "full_name": "Ana Sintética", "role": "admin", "active": float64(1)}
		if status, body := get(t, mux, "/system/auth/me", "sipges_session="+token); status != 200 || !reflect.DeepEqual(body, want) {
			t.Errorf("me with a session: %d %v", status, body)
		}
	}
	mux := http.NewServeMux()
	identityhttp.Routes(mux, failing{}, false, quiet)
	if status, body := get(t, mux, "/system/auth/me", "sipges_session="+token); status != 500 || !reflect.DeepEqual(body, map[string]any{"detail": "Internal Server Error"}) {
		t.Errorf("me with a failing store: %d %v", status, body)
	}
}
