package httpx

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/logging"
)

func newHandler(t *testing.T, opts Options) (http.Handler, *bytes.Buffer) {
	t.Helper()
	var buf bytes.Buffer
	opts.Logger = logging.New(&buf, slog.LevelInfo)
	return NewHandler(opts), &buf
}

func do(h http.Handler, method, target string, header map[string]string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, target, nil)
	for k, v := range header {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func assertJSON(t *testing.T, rec *httptest.ResponseRecorder, status int, body string) {
	t.Helper()
	if rec.Code != status {
		t.Fatalf("status = %d, want %d (body %s)", rec.Code, status, rec.Body)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/json" {
		t.Fatalf("Content-Type = %q", ct)
	}
	if got := strings.TrimSpace(rec.Body.String()); got != body {
		t.Fatalf("body = %s, want %s", got, body)
	}
}

func TestHealthIsStatic(t *testing.T) {
	t.Parallel()
	h, _ := newHandler(t, Options{Ready: func(context.Context) error { return errors.New("down") }})
	assertJSON(t, do(h, http.MethodGet, "/health", nil), 200, `{"status":"ok","service":"SIPGES","version":"V0.5.1"}`)
}

func TestReadiness(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name   string
		ready  ReadyFunc
		status int
		body   string
	}{
		{"database answers", func(context.Context) error { return nil }, 200, `{"status":"ready"}`},
		{"database fails", func(context.Context) error {
			return errors.New("dial postgres://u:synthetic-secret@h/db")
		}, 503, `{"status":"unavailable"}`},
		{"database too slow", func(ctx context.Context) error {
			<-ctx.Done()
			return ctx.Err()
		}, 503, `{"status":"unavailable"}`},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			h, logs := newHandler(t, Options{Ready: tc.ready, ReadyTimeout: 50 * time.Millisecond})
			start := time.Now()
			assertJSON(t, do(h, http.MethodGet, "/health/ready", nil), tc.status, tc.body)
			if elapsed := time.Since(start); elapsed > time.Second {
				t.Fatalf("readiness took %v", elapsed)
			}
			if strings.Contains(logs.String(), "synthetic-secret") {
				t.Fatalf("readiness cause logged: %s", logs)
			}
		})
	}
}

func TestUnknownRoutesAndMethodsAreJSON404(t *testing.T) {
	t.Parallel()
	h, _ := newHandler(t, Options{Ready: func(context.Context) error { return nil }})
	for _, tc := range []struct{ method, target string }{
		{http.MethodGet, "/nope"},
		{http.MethodPost, "/health"},
		{http.MethodGet, "/api/records"},
	} {
		assertJSON(t, do(h, tc.method, tc.target, nil), 404, `{"detail":"Not Found"}`)
	}
}

func TestPanicsBecomeJSON500(t *testing.T) {
	t.Parallel()
	var buf bytes.Buffer
	log := logging.New(&buf, slog.LevelInfo)
	h := Chain(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { panic("synthetic failure") }), RequestID(), Recover(log))
	assertJSON(t, do(h, http.MethodGet, "/boom", nil), 500, `{"detail":"Internal Server Error"}`)
	if !strings.Contains(buf.String(), `"msg":"panic"`) {
		t.Fatalf("panic not logged: %s", buf.String())
	}
}

var uuidV4 = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)

func TestRequestID(t *testing.T) {
	t.Parallel()
	h, _ := newHandler(t, Options{Ready: func(context.Context) error { return nil }})
	if got := do(h, http.MethodGet, "/health", map[string]string{"X-Request-Id": "caller-id.0001"}).Header().Get("X-Request-Id"); got != "caller-id.0001" {
		t.Fatalf("safe caller id not kept: %q", got)
	}
	for _, unsafe := range []string{"short", "has space in it", "inject\"quote\"x", strings.Repeat("a", 65)} {
		got := do(h, http.MethodGet, "/health", map[string]string{"X-Request-Id": unsafe}).Header().Get("X-Request-Id")
		if !uuidV4.MatchString(got) {
			t.Fatalf("unsafe id %q replaced by %q, want a UUID v4", unsafe, got)
		}
	}
	a := do(h, http.MethodGet, "/health", nil).Header().Get("X-Request-Id")
	b := do(h, http.MethodGet, "/health", nil).Header().Get("X-Request-Id")
	if !uuidV4.MatchString(a) || a == b {
		t.Fatalf("generated ids %q and %q", a, b)
	}
}

func TestAccessLogHasNoQueryStringOrHeaders(t *testing.T) {
	t.Parallel()
	h, logs := newHandler(t, Options{Ready: func(context.Context) error { return nil }, AccessLog: true})
	do(h, http.MethodGet, "/health?token=synthetic-secret", map[string]string{
		"X-Request-Id": "caller-id.0002", "Cookie": "sid=synthetic-secret", "Authorization": "Bearer synthetic-secret",
	})
	line := logs.String()
	if strings.Contains(line, "synthetic-secret") {
		t.Fatalf("secret in access log: %s", line)
	}
	var entry map[string]any
	if err := json.Unmarshal([]byte(line), &entry); err != nil {
		t.Fatalf("access log not one JSON line: %v: %s", err, line)
	}
	if entry["msg"] != "request" || entry["path"] != "/health" || entry["status"] != float64(200) || entry["request_id"] != "caller-id.0002" || entry["method"] != "GET" {
		t.Fatalf("entry = %v", entry)
	}
	if _, ok := entry["duration_ms"]; !ok {
		t.Fatalf("no duration: %v", entry)
	}
}

func TestAccessLogOff(t *testing.T) {
	t.Parallel()
	h, logs := newHandler(t, Options{Ready: func(context.Context) error { return nil }})
	do(h, http.MethodGet, "/health", nil)
	if logs.Len() != 0 {
		t.Fatalf("logged with access log off: %s", logs)
	}
}

func TestHostAllowlist(t *testing.T) {
	t.Parallel()
	h, _ := newHandler(t, Options{Ready: func(context.Context) error { return nil }, AllowedHosts: []string{"sipges.example.org", "[::1]"}})
	for host, status := range map[string]int{
		"sipges.example.org":     200,
		"SIPGES.example.org:443": 200,
		"[::1]:8000":             200,
		"evil.example":           400,
		"":                       400,
	} {
		req := httptest.NewRequest(http.MethodGet, "/health", nil)
		req.Host = host
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code != status {
			t.Fatalf("host %q: status %d, want %d", host, rec.Code, status)
		}
		if status == 400 {
			assertJSON(t, rec, 400, `{"detail":"Host no permitido"}`)
		}
	}
}

func TestServeShutsDownGracefully(t *testing.T) {
	t.Parallel()
	started := make(chan struct{})
	release := make(chan struct{})
	handler := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		close(started)
		<-release
		_, _ = io.WriteString(w, "done")
	})
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	served := make(chan error, 1)
	go func() { served <- Serve(ctx, NewServer(handler), ln, 5*time.Second) }()

	got := make(chan string, 1)
	go func() {
		resp, err := http.Get("http://" + ln.Addr().String() + "/slow")
		if err != nil {
			got <- err.Error()
			return
		}
		defer func() { _ = resp.Body.Close() }()
		body, _ := io.ReadAll(resp.Body)
		got <- string(body)
	}()
	<-started
	cancel() // like SIGTERM: stop accepting, let the in-flight request finish
	time.Sleep(50 * time.Millisecond)
	if _, err := net.DialTimeout("tcp", ln.Addr().String(), 200*time.Millisecond); err == nil {
		t.Fatal("still accepting connections after shutdown started")
	}
	close(release)
	if body := <-got; body != "done" {
		t.Fatalf("in-flight request got %q", body)
	}
	if err := <-served; err != nil {
		t.Fatalf("Serve = %v", err)
	}
}

// Hono routes a path with an empty segment as is, and nothing matches it; ServeMux would
// redirect it to its cleaned form instead (307 HTML), so the API answers the JSON 404.
func TestEmptySegmentsAreJSON404NotRedirects(t *testing.T) {
	t.Parallel()
	h, _ := newHandler(t, Options{Ready: func(context.Context) error { return nil }})
	for _, target := range []string{"/health//", "/x//health", "/health/ready//"} {
		assertJSON(t, do(h, http.MethodGet, target, nil), 404, `{"detail":"Not Found"}`)
	}
	// A raw //health target (what the parity runner sends) reaches the handler the same way.
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.RequestURI, req.URL.Path = "//health", "//health"
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	assertJSON(t, rec, 404, `{"detail":"Not Found"}`)
}
