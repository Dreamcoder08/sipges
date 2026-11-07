package httpx_test

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/httpx"
)

// The headers of security-headers.ts, which the Worker adds in front of Go on Cloudflare.
func TestSecurityHeadersOnAnAPIResponse(t *testing.T) {
	h := httpx.SecurityHeaders(httpx.SecurityOptions{HSTS: true})(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		httpx.WriteJSON(w, http.StatusOK, map[string]string{"ok": "1"})
	}))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/x", nil))
	want := map[string]string{
		"X-Content-Type-Options":    "nosniff",
		"X-Frame-Options":           "DENY",
		"Referrer-Policy":           "no-referrer",
		"Cache-Control":             "no-store",
		"Content-Security-Policy":   httpx.APICSP,
		"Permissions-Policy":        "camera=(), microphone=(), geolocation=()",
		"Strict-Transport-Security": "max-age=31536000; includeSubDomains",
	}
	for name, value := range want {
		if got := rec.Header().Get(name); got != value {
			t.Errorf("%s = %q, want %q", name, got, value)
		}
	}
}

func TestSecurityHeadersLeaveOutHSTSWithoutSecureCookies(t *testing.T) {
	h := httpx.SecurityHeaders(httpx.SecurityOptions{})(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/", nil))
	if got := rec.Header().Get("Strict-Transport-Security"); got != "" {
		t.Fatalf("HSTS = %q", got)
	}
}

func TestSecurityHeadersKeepAStricterPolicyAndAssetCache(t *testing.T) {
	h := httpx.SecurityHeaders(httpx.SecurityOptions{})(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Security-Policy", "sandbox")
		w.Header().Set("Referrer-Policy", "strict-origin-when-cross-origin")
		w.Header().Set("Cache-Control", httpx.AssetCache)
		_, _ = w.Write([]byte("x"))
	}))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/", nil))
	if got := rec.Header().Get("Content-Security-Policy"); got != "sandbox" {
		t.Errorf("CSP = %q", got)
	}
	if got := rec.Header().Get("Referrer-Policy"); got != "strict-origin-when-cross-origin" {
		t.Errorf("Referrer-Policy = %q", got)
	}
	if got := rec.Header().Get("Cache-Control"); got != httpx.AssetCache {
		t.Errorf("Cache-Control = %q", got)
	}
}

// Anything but the two asset values is replaced, so a handler can never make API data cacheable.
func TestSecurityHeadersReplaceAnyOtherCacheControl(t *testing.T) {
	h := httpx.SecurityHeaders(httpx.SecurityOptions{})(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Cache-Control", "public, max-age=60")
		w.WriteHeader(http.StatusOK)
	}))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/", nil))
	if got := rec.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("Cache-Control = %q", got)
	}
}

// A handler that returns without writing still gets them.
func TestSecurityHeadersOnAnEmptyHandler(t *testing.T) {
	h := httpx.SecurityHeaders(httpx.SecurityOptions{})(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/", nil))
	if got := rec.Header().Get("X-Frame-Options"); got != "DENY" {
		t.Fatalf("X-Frame-Options = %q", got)
	}
}

// The event stream flushes before its handler ends: the headers must leave with that flush, and
// the controller must still reach the real writer for the flush and the write deadline.
func TestSecurityHeadersSurviveAFlushAndKeepTheController(t *testing.T) {
	flushed := make(chan struct{})
	release := make(chan struct{})
	srv := httptest.NewServer(httpx.SecurityHeaders(httpx.SecurityOptions{})(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		rc := http.NewResponseController(w)
		if err := rc.SetWriteDeadline(time.Now().Add(time.Minute)); err != nil {
			t.Errorf("deadline: %v", err)
		}
		w.Header().Set("Content-Type", "text/event-stream")
		if err := rc.Flush(); err != nil {
			t.Errorf("flush: %v", err)
		}
		close(flushed)
		<-release
	})))
	defer srv.Close()
	defer close(release)
	resp, err := http.Get(srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	<-flushed
	if got := resp.Header.Get("Cache-Control"); got != "no-store" {
		t.Fatalf("Cache-Control = %q, want no-store on the flushed headers", got)
	}
}
