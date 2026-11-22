package http

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/identity/domain"
)

type oneSession struct{ expires time.Time }

func (s oneSession) Authenticate(context.Context, string) (*domain.Principal, error) {
	return &domain.Principal{Username: "synthetic", Role: domain.Role("analista"), MFAEnabled: true, SessionExpiresAt: s.expires}, nil
}

type failingActivity struct{}

func (failingActivity) Record(context.Context, string, time.Time, bool) (int, error) {
	return 600, errors.New("synthetic database outage")
}

func TestAFailedExtensionIsLoggedWithItsCauseAndTheRequestGoesOn(t *testing.T) {
	var logs bytes.Buffer
	mw := Session(SessionOptions{
		Sessions: oneSession{expires: time.Now().Add(10 * time.Minute)},
		Logger:   slog.New(slog.NewJSONHandler(&logs, nil)),
		Activity: failingActivity{},
	})
	reached := false
	h := mw(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { reached = true; w.WriteHeader(http.StatusNoContent) }))
	r := httptest.NewRequest(http.MethodGet, "/system/records", nil)
	r.AddCookie(&http.Cookie{Name: SessionCookie, Value: "token"})
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)

	if !reached || w.Code != http.StatusNoContent || w.Header().Get(RemainingHeader) != "600" {
		t.Fatalf("reached=%v status=%d remaining=%q", reached, w.Code, w.Header().Get(RemainingHeader))
	}
	if !strings.Contains(logs.String(), `"msg":"session extension failed"`) || !strings.Contains(logs.String(), `"error":"synthetic database outage"`) {
		t.Fatalf("log = %s", logs.String())
	}
}
