package httpapi_test

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/dreamcoder08/sipges/spikes/go-container/internal/dbping"
	"github.com/dreamcoder08/sipges/spikes/go-container/internal/httpapi"
)

type okSession struct{}

func (okSession) Ping(context.Context) error  { return nil }
func (okSession) Encrypted() bool             { return true }
func (okSession) Close(context.Context) error { return nil }

type connector struct{ err error }

func (c connector) Connect(context.Context) (dbping.Session, dbping.ConnectTimings, error) {
	if c.err != nil {
		return nil, dbping.ConnectTimings{}, c.err
	}
	return okSession{}, dbping.ConnectTimings{TCP: time.Millisecond, TLS: 2 * time.Millisecond, Total: 5 * time.Millisecond}, nil
}

func newHandler() http.Handler {
	started := time.Date(2026, 11, 3, 12, 0, 0, 0, time.UTC)
	return httpapi.New(httpapi.Deps{
		Targets: map[string]dbping.Connector{
			"direct": connector{},
			"broken": connector{err: errors.New("dial tcp: connection refused")},
		},
		Placement: httpapi.Placement{Location: "IAD", Region: "ENAM", Country: "US"},
		StartedAt: started,
		Now:       func() time.Time { return started.Add(1500 * time.Millisecond) },
	})
}

func serve(t *testing.T, method, target string) (*httptest.ResponseRecorder, map[string]any) {
	t.Helper()
	rec := httptest.NewRecorder()
	newHandler().ServeHTTP(rec, httptest.NewRequest(method, target, nil))
	var body map[string]any
	if rec.Body.Len() > 0 && rec.Header().Get("Content-Type") == "application/json" {
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Fatalf("invalid JSON %q: %v", rec.Body.String(), err)
		}
	}
	return rec, body
}

func TestHealth(t *testing.T) {
	rec, body := serve(t, http.MethodGet, "/health")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if body["status"] != "ok" || body["uptimeMs"] != 1500.0 {
		t.Errorf("body = %v", body)
	}
	placement, _ := body["placement"].(map[string]any)
	if placement["region"] != "ENAM" || placement["location"] != "IAD" {
		t.Errorf("placement = %v", placement)
	}
	if got := rec.Header().Get("Cache-Control"); got != "no-store" {
		t.Errorf("Cache-Control = %q, want no-store", got)
	}
}

func TestDBPing(t *testing.T) {
	tests := []struct {
		name       string
		method     string
		target     string
		wantStatus int
		wantError  string
	}{
		{name: "default target and count", method: http.MethodGet, target: "/db-ping", wantStatus: http.StatusOK},
		{name: "explicit count", method: http.MethodGet, target: "/db-ping?n=60&target=direct", wantStatus: http.StatusOK},
		{name: "non-numeric count", method: http.MethodGet, target: "/db-ping?n=abc", wantStatus: http.StatusBadRequest, wantError: "invalid_count"},
		{name: "count over limit", method: http.MethodGet, target: "/db-ping?n=1001", wantStatus: http.StatusBadRequest, wantError: "invalid_count"},
		{name: "unknown target", method: http.MethodGet, target: "/db-ping?target=nope", wantStatus: http.StatusBadRequest, wantError: "unknown_target"},
		{name: "database unreachable", method: http.MethodGet, target: "/db-ping?target=broken", wantStatus: http.StatusBadGateway, wantError: "database_unreachable"},
		{name: "wrong method", method: http.MethodPost, target: "/db-ping", wantStatus: http.StatusMethodNotAllowed},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			rec, body := serve(t, tt.method, tt.target)
			if rec.Code != tt.wantStatus {
				t.Fatalf("status = %d, want %d (body %s)", rec.Code, tt.wantStatus, rec.Body.String())
			}
			if tt.wantError != "" {
				errBody, _ := body["error"].(map[string]any)
				if errBody["code"] != tt.wantError {
					t.Errorf("error = %v, want code %q", body["error"], tt.wantError)
				}
			}
		})
	}
}

func TestDBPingReportsMeasurements(t *testing.T) {
	_, body := serve(t, http.MethodGet, "/db-ping?n=60")
	if body["target"] != "direct" || body["queries"] != 60.0 || body["encrypted"] != true || body["tlsHandshakeMs"] != 2.0 {
		t.Errorf("body = %v", body)
	}
	warm, _ := body["warmQueries"].(map[string]any)
	if warm["count"] != 60.0 {
		t.Errorf("warmQueries = %v", warm)
	}
}

func TestUnknownRoute(t *testing.T) {
	if rec, _ := serve(t, http.MethodGet, "/nope"); rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
}

func TestEgress(t *testing.T) {
	trace := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("fl=1\nip=203.0.113.7\ncolo=IAD\nloc=US\nwarp=off\n"))
	}))
	defer trace.Close()
	h := httpapi.New(httpapi.Deps{Now: time.Now, StartedAt: time.Now(), TraceURL: trace.URL, HTTPClient: trace.Client()})

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/egress", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body["colo"] != "IAD" || body["loc"] != "US" {
		t.Errorf("body = %v, want colo IAD and loc US", body)
	}
	if _, leaked := body["ip"]; leaked {
		t.Errorf("egress IP must not be exposed: %v", body)
	}
}

func TestEgressUpstreamFailure(t *testing.T) {
	h := httpapi.New(httpapi.Deps{Now: time.Now, StartedAt: time.Now(), TraceURL: "http://127.0.0.1:1/trace", HTTPClient: http.DefaultClient})
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/egress", nil))
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502", rec.Code)
	}
}

type blockingConnector struct{}

func (blockingConnector) Connect(ctx context.Context) (dbping.Session, dbping.ConnectTimings, error) {
	<-ctx.Done() // a blackholed host: only the deadline ends the dial
	return nil, dbping.ConnectTimings{}, ctx.Err()
}

func TestDBPingHasItsOwnDeadline(t *testing.T) {
	h := httpapi.New(httpapi.Deps{
		Targets:      map[string]dbping.Connector{"direct": blockingConnector{}},
		Now:          time.Now,
		StartedAt:    time.Now(),
		PingDeadline: 50 * time.Millisecond,
	})
	done := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/db-ping", nil))
		done <- rec
	}()
	select {
	case rec := <-done:
		if rec.Code != http.StatusGatewayTimeout {
			t.Fatalf("status = %d, want 504 (body %s)", rec.Code, rec.Body.String())
		}
	case <-time.After(5 * time.Second):
		t.Fatal("/db-ping did not honour its deadline")
	}
}
