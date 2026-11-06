package httpx

import (
	"context"
	_ "embed"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

//go:embed testdata/metrics/metrics.txt
var recordedMetrics string

func TestMetricsPrintTheTypeScriptTextForTheSameObservations(t *testing.T) {
	m := NewMetrics(time.Now)
	m.Observe("GET", "/api/:module", 200, 0.004)
	m.Observe("GET", "/api/:module", 200, 0.03)
	m.Observe("GET", "/api/:module", 404, 0.25)
	m.Observe("POST", "/api/:module", 500, 12)
	m.Observe("GET", "/health", 200, 0.001)
	m.Observe("HEAD", "unmatched", 404, 1)
	m.Observe("GET", "a\"b\\c\nd", 301, 0.0000015)
	got := m.Render()
	got, _, found := strings.Cut(got, "# HELP sipges_process_uptime_seconds")
	if !found || got != recordedMetrics {
		t.Fatalf("got\n%s\nwant\n%s", got, recordedMetrics)
	}
}

func TestMetricsReportTheProcess(t *testing.T) {
	at := time.Unix(100, 0)
	m := NewMetrics(func() time.Time { return at })
	at = at.Add(1500 * time.Millisecond)
	got := m.Render()
	for _, want := range []string{
		"# TYPE sipges_process_uptime_seconds gauge\nsipges_process_uptime_seconds 1.500\n",
		"# TYPE sipges_process_resident_memory_bytes gauge\nsipges_process_resident_memory_bytes ",
		"# TYPE sipges_process_heap_used_bytes gauge\nsipges_process_heap_used_bytes ",
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("missing %q in\n%s", want, got)
		}
	}
	if !strings.HasSuffix(got, "\n") {
		t.Fatal("the text must end in a newline")
	}
}

func metricsServer(t *testing.T, auth ...Middleware) (*httptest.Server, *Metrics) {
	t.Helper()
	m := NewMetrics(time.Now)
	h := NewHandler(Options{
		Logger:  slog.New(slog.DiscardHandler),
		Ready:   func(context.Context) error { return nil },
		Metrics: m,
		Auth:    auth,
		Routes: func(mux *http.ServeMux) {
			mux.HandleFunc("GET /api/{module}/{id}", func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(http.StatusNoContent)
			})
			mux.HandleFunc("GET /boom", func(http.ResponseWriter, *http.Request) { panic("synthetic") })
		},
	})
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	return srv, m
}

// call answers with the body read and closed.
func call(t *testing.T, method, url string) (int, http.Header, []byte) {
	t.Helper()
	r, err := http.NewRequestWithContext(t.Context(), method, url, nil)
	if err != nil {
		t.Fatal(err)
	}
	res, err := http.DefaultClient.Do(r)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = res.Body.Close() }()
	b, err := io.ReadAll(res.Body)
	if err != nil {
		t.Fatal(err)
	}
	return res.StatusCode, res.Header, b
}

// eventually waits for the text to hold want: a request is counted after its response left.
func eventually(t *testing.T, m *Metrics, want ...string) string {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for {
		got := m.Render()
		missing := ""
		for _, w := range want {
			if !strings.Contains(got, w) {
				missing = w
			}
		}
		if missing == "" {
			return got
		}
		if time.Now().After(deadline) {
			t.Fatalf("missing %q in\n%s", missing, got)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func TestRequestsAreCountedByRoutePatternNeverByRawPath(t *testing.T) {
	srv, m := metricsServer(t)
	call(t, "GET", srv.URL+"/api/actores/secret-id?token=x")
	call(t, "GET", srv.URL+"/no-such-route")
	call(t, "GET", srv.URL+"/boom")
	got := eventually(t, m,
		`sipges_http_requests_total{method="GET",route="/api/:module/:id",status="2xx"} 1`,
		`sipges_http_requests_total{method="GET",route="unmatched",status="4xx"} 1`,
		`sipges_http_requests_total{method="GET",route="/boom",status="5xx"} 1`,
	)
	if strings.Contains(got, "secret-id") || strings.Contains(got, "token") {
		t.Fatalf("a raw path reached the labels:\n%s", got)
	}
}

func TestARequestAGateStopsKeepsItsRouteLabel(t *testing.T) {
	refuse := func(http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { WriteError(w, http.StatusUnauthorized, "no") })
	}
	srv, m := metricsServer(t, refuse)
	call(t, "GET", srv.URL+"/api/actores/1")
	eventually(t, m, `sipges_http_requests_total{method="GET",route="/api/:module/:id",status="4xx"} 1`)
}

// Go's server accepts any method token, so a label per method would let anyone grow the series
// without a session; TypeScript's HTTP parser only knows a fixed list.
func TestAnInventedMethodCannotGrowTheSeries(t *testing.T) {
	srv, m := metricsServer(t)
	call(t, "FOOA", srv.URL+"/x")
	call(t, "FOOB", srv.URL+"/x")
	got := eventually(t, m, `sipges_http_requests_total{method="OTHER",route="unmatched",status="4xx"} 2`)
	if strings.Contains(got, "FOO") {
		t.Fatalf("an invented method reached the labels:\n%s", got)
	}
}

func TestMetricsRouteAnswersPlainTextThatIsNeverCached(t *testing.T) {
	srv, _ := metricsServer(t)
	status, header, b := call(t, "GET", srv.URL+"/system/metrics")
	if status != http.StatusOK || header.Get("Content-Type") != "text/plain; version=0.0.4; charset=utf-8" ||
		header.Get("Cache-Control") != "no-store" || !strings.Contains(string(b), "sipges_process_uptime_seconds") {
		t.Fatalf("%d %v\n%s", status, header, b)
	}
}

func TestAHandlerWithoutMetricsServesNoMetricsRoute(t *testing.T) {
	srv := httptest.NewServer(NewHandler(Options{Logger: slog.New(slog.DiscardHandler), Ready: func(context.Context) error { return nil }}))
	defer srv.Close()
	if status, _, _ := call(t, "GET", srv.URL+"/system/metrics"); status != http.StatusNotFound {
		t.Fatalf("status %d", status)
	}
}
