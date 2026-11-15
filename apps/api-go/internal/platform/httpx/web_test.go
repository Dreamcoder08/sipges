package httpx_test

import (
	"context"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/httpx"
)

// webDir writes a small build: what apps/web/dist holds, with synthetic contents.
func webDir(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	files := map[string]string{
		"index.html":                   "<!doctype html><title>shell</title>",
		"sw.js":                        "self.x=1",
		"manifest.webmanifest":         "{}",
		"icon.svg":                     "<svg/>",
		"favicon.ico":                  "ico",
		"favicon.svg":                  "<svg/>",
		"robots.txt":                   "User-agent: *\nDisallow: /\n",
		"secret.txt":                   "not served",
		"assets/app-abc.js":            "console.log(1)",
		"assets/app-abc.css":           "a{}",
		"assets/data.bin":              "binary",
		"cesium/Workers/worker.js":     "w",
		"cesium/Assets/Textures/a.jpg": "jpg",
		"cesium/Other/x.js":            "outside the three folders",
	}
	for name, body := range files {
		path := filepath.Join(dir, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

// fallthroughHandler stands for the API: the status says the SPA did not answer.
var fallthroughHandler = http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
	w.WriteHeader(http.StatusTeapot)
})

func webRequest(t *testing.T, dir, method, path, accept string) *httptest.ResponseRecorder {
	t.Helper()
	web, err := httpx.Web(dir)
	if err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest(method, path, nil)
	if accept != "" {
		r.Header.Set("Accept", accept)
	}
	rec := httptest.NewRecorder()
	web(fallthroughHandler).ServeHTTP(rec, r)
	return rec
}

func TestWebServesTheShellToABrowserNavigation(t *testing.T) {
	dir := webDir(t)
	for _, path := range []string{"/", "/registros/alertas", "/system", "/health/x"} {
		rec := webRequest(t, dir, http.MethodGet, path, "text/html,application/xhtml+xml")
		if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "shell") {
			t.Fatalf("%s: %d %q", path, rec.Code, rec.Body.String())
		}
		if got := rec.Header().Get("Content-Type"); got != "text/html; charset=UTF-8" {
			t.Errorf("%s: Content-Type = %q", path, got)
		}
		if got := rec.Header().Get("Content-Security-Policy"); got != httpx.SPACSP {
			t.Errorf("%s: CSP = %q", path, got)
		}
		if got := rec.Header().Get("Referrer-Policy"); got != "strict-origin-when-cross-origin" {
			t.Errorf("%s: Referrer-Policy = %q", path, got)
		}
	}
}

// The API's own paths never get the shell, whatever the browser accepts.
func TestWebLeavesTheAPIAlone(t *testing.T) {
	dir := webDir(t)
	for _, path := range []string{"/api/x", "/system/events", "/auth/google", "/health", "/health/ready", "/select-project", "/logout"} {
		if rec := webRequest(t, dir, http.MethodGet, path, "text/html"); rec.Code != http.StatusTeapot {
			t.Errorf("%s: %d", path, rec.Code)
		}
	}
}

func TestWebLeavesRequestsThatAreNotNavigations(t *testing.T) {
	dir := webDir(t)
	if rec := webRequest(t, dir, http.MethodGet, "/registros", "application/json"); rec.Code != http.StatusTeapot {
		t.Errorf("json: %d", rec.Code)
	}
	if rec := webRequest(t, dir, http.MethodGet, "/registros", ""); rec.Code != http.StatusTeapot {
		t.Errorf("no accept: %d", rec.Code)
	}
	if rec := webRequest(t, dir, http.MethodPost, "/registros", "text/html"); rec.Code != http.StatusTeapot {
		t.Errorf("post: %d", rec.Code)
	}
}

func TestWebServesHashedAssetsForAYear(t *testing.T) {
	rec := webRequest(t, webDir(t), http.MethodGet, "/assets/app-abc.js", "*/*")
	if rec.Code != http.StatusOK || rec.Body.String() != "console.log(1)" {
		t.Fatalf("%d %q", rec.Code, rec.Body.String())
	}
	if got := rec.Header().Get("Content-Type"); got != "text/javascript; charset=utf-8" {
		t.Errorf("Content-Type = %q", got)
	}
	if got := rec.Header().Get("Cache-Control"); got != httpx.AssetCache {
		t.Errorf("Cache-Control = %q", got)
	}
}

func TestWebServesCesiumForADayUnderTheSPAPolicy(t *testing.T) {
	rec := webRequest(t, webDir(t), http.MethodGet, "/cesium/Workers/worker.js", "*/*")
	if rec.Code != http.StatusOK || rec.Body.String() != "w" {
		t.Fatalf("%d %q", rec.Code, rec.Body.String())
	}
	if got := rec.Header().Get("Cache-Control"); got != httpx.CesiumCache {
		t.Errorf("Cache-Control = %q", got)
	}
	if got := rec.Header().Get("Content-Security-Policy"); got != httpx.SPACSP {
		t.Errorf("CSP = %q", got)
	}
}

func TestWebServesInstallableRootFilesUnderTheSPAPolicy(t *testing.T) {
	cases := map[string]string{
		"/manifest.webmanifest": "application/manifest+json",
		"/sw.js":                "text/javascript; charset=utf-8",
		"/icon.svg":             "image/svg+xml",
		"/favicon.ico":          "image/x-icon",
		"/favicon.svg":          "image/svg+xml",
		"/robots.txt":           "text/plain; charset=utf-8",
	}
	dir := webDir(t)
	for path, contentType := range cases {
		rec := webRequest(t, dir, http.MethodGet, path, "*/*")
		if rec.Code != http.StatusOK {
			t.Fatalf("%s: %d", path, rec.Code)
		}
		if got := rec.Header().Get("Content-Type"); got != contentType {
			t.Errorf("%s: Content-Type = %q", path, got)
		}
		if got := rec.Header().Get("Content-Security-Policy"); got != httpx.SPACSP {
			t.Errorf("%s: CSP = %q", path, got)
		}
	}
}

// functional-10 T9: the crawler rule keeps every crawler out.
func TestWebServesRobotsTxtThatDisallowsEverything(t *testing.T) {
	rec := webRequest(t, webDir(t), http.MethodGet, "/robots.txt", "*/*")
	if rec.Code != http.StatusOK || rec.Body.String() != "User-agent: *\nDisallow: /\n" {
		t.Fatalf("%d %q", rec.Code, rec.Body.String())
	}
}

// encodedRequest is webRequest with an Accept-Encoding header; "-" sends none.
func encodedRequest(t *testing.T, dir, path, acceptEncoding string) *httptest.ResponseRecorder {
	t.Helper()
	web, err := httpx.Web(dir)
	if err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest(http.MethodGet, path, nil)
	if acceptEncoding != "-" {
		r.Header.Set("Accept-Encoding", acceptEncoding)
	}
	rec := httptest.NewRecorder()
	web(fallthroughHandler).ServeHTTP(rec, r)
	return rec
}

// functional-10 T9: the brotli or gzip variant the build wrote, when the client takes it, with
// the same type and cache headers; the plain file otherwise. Spa.ts answers the same.
func TestWebServesPrecompressedAssets(t *testing.T) {
	dir := webDir(t)
	for name, body := range map[string]string{
		"assets/app-abc.js.br":  "br bytes",
		"assets/app-abc.js.gz":  "gzip bytes",
		"assets/only-gz.css":    "a{}",
		"assets/only-gz.css.gz": "css gzip",
		"assets/logo.png":       "png",
		"assets/logo.png.br":    "never",
	} {
		if err := os.WriteFile(filepath.Join(dir, filepath.FromSlash(name)), []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	cases := []struct{ path, acceptEncoding, body, encoding string }{
		{"/assets/app-abc.js", "gzip, deflate, br, zstd", "br bytes", "br"},
		{"/assets/app-abc.js", "gzip", "gzip bytes", "gzip"},
		{"/assets/app-abc.js", "br;q=0, gzip;q=0.5", "gzip bytes", "gzip"},
		{"/assets/app-abc.js", "*", "br bytes", "br"},
		{"/assets/app-abc.js", "BR;Q=1", "br bytes", "br"},
		{"/assets/app-abc.js", "gzip;q=0, br;q=0", "console.log(1)", ""},
		{"/assets/app-abc.js", "*;q=0", "console.log(1)", ""},
		{"/assets/app-abc.js", "identity", "console.log(1)", ""},
		{"/assets/app-abc.js", "", "console.log(1)", ""},
		{"/assets/app-abc.js", "-", "console.log(1)", ""},
		{"/assets/only-gz.css", "br, gzip", "css gzip", "gzip"},
		{"/assets/only-gz.css", "br", "a{}", ""},
	}
	for _, c := range cases {
		label := c.path + " with " + c.acceptEncoding
		rec := encodedRequest(t, dir, c.path, c.acceptEncoding)
		if rec.Code != http.StatusOK || rec.Body.String() != c.body {
			t.Errorf("%s: %d %q", label, rec.Code, rec.Body.String())
			continue
		}
		if got := rec.Header().Get("Content-Encoding"); got != c.encoding {
			t.Errorf("%s: Content-Encoding = %q", label, got)
		}
		if got := rec.Header().Get("Vary"); got != "Accept-Encoding" {
			t.Errorf("%s: Vary = %q", label, got)
		}
		if got := rec.Header().Get("Cache-Control"); got != httpx.AssetCache {
			t.Errorf("%s: Cache-Control = %q", label, got)
		}
		if got, want := rec.Header().Get("Content-Length"), strconv.Itoa(len(c.body)); got != want {
			t.Errorf("%s: Content-Length = %q, want %q", label, got, want)
		}
		want := "text/css; charset=utf-8"
		if strings.HasSuffix(c.path, ".js") {
			want = "text/javascript; charset=utf-8"
		}
		if got := rec.Header().Get("Content-Type"); got != want {
			t.Errorf("%s: Content-Type = %q", label, got)
		}
	}
	png := encodedRequest(t, dir, "/assets/logo.png", "br, gzip")
	if png.Body.String() != "png" || png.Header().Get("Content-Encoding") != "" || png.Header().Get("Vary") != "" {
		t.Errorf("png: %q %v", png.Body.String(), png.Header())
	}
	if rec := encodedRequest(t, dir, "/assets/app-abc.js.br", "br"); rec.Code != http.StatusNotFound {
		t.Errorf("variant by its own name: %d", rec.Code)
	}
	if rec := encodedRequest(t, dir, "/assets/missing.js", "br"); rec.Code != http.StatusNotFound || rec.Header().Get("Vary") != "" || rec.Header().Get("Cache-Control") != "" {
		t.Errorf("missing: %d %v", rec.Code, rec.Header())
	}
}

// A name that fails validation, an unknown type or a missing file is the JSON 404, and nothing
// outside the three served folders can be reached.
func TestWebRefusesWhatIsNotABuiltFile(t *testing.T) {
	dir := webDir(t)
	for _, path := range []string{
		"/assets/missing.js",
		"/assets/data.bin",
		"/assets/.hidden.js",
		"/assets/sub/app.js",
		"/assets/..%2Fsecret.txt",
		"/assets/%2e%2e/secret.txt",
		"/cesium/Other/x.js",
		"/cesium/Workers/../../secret.txt",
		"/cesium/Workers/missing.js",
		"/cesium/Workers",
	} {
		rec := webRequest(t, dir, http.MethodGet, path, "*/*")
		if rec.Code != http.StatusNotFound {
			t.Errorf("%s: %d %q", path, rec.Code, rec.Body.String())
			continue
		}
		if got := strings.TrimSpace(rec.Body.String()); got != `{"detail":"Not Found"}` {
			t.Errorf("%s: body %q", path, got)
		}
	}
}

// A link inside the build must not be a way out of it.
func TestWebDoesNotFollowALinkOutOfTheBuild(t *testing.T) {
	dir := webDir(t)
	outside := filepath.Join(t.TempDir(), "outside.js")
	if err := os.WriteFile(outside, []byte("secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(dir, "assets", "link.js")); err != nil {
		t.Fatal(err)
	}
	if rec := webRequest(t, dir, http.MethodGet, "/assets/link.js", "*/*"); rec.Code != http.StatusNotFound {
		t.Fatalf("%d %q", rec.Code, rec.Body.String())
	}
}

// HEAD answers like GET, as Hono's GET routes do through the Node adapter.
func TestWebAnswersHead(t *testing.T) {
	if rec := webRequest(t, webDir(t), http.MethodHead, "/assets/app-abc.css", "*/*"); rec.Code != http.StatusOK {
		t.Fatalf("%d", rec.Code)
	}
}

// Without a shell the navigation reaches the API, as spaMiddleware's next() does.
func TestWebFallsThroughWithoutAShell(t *testing.T) {
	dir := webDir(t)
	if err := os.Remove(filepath.Join(dir, "index.html")); err != nil {
		t.Fatal(err)
	}
	if rec := webRequest(t, dir, http.MethodGet, "/", "text/html"); rec.Code != http.StatusTeapot {
		t.Fatalf("%d", rec.Code)
	}
}

func TestWebRefusesAMissingBuild(t *testing.T) {
	if _, err := httpx.Web(filepath.Join(t.TempDir(), "none")); err == nil {
		t.Fatal("no error")
	}
}

// The order of createApp: the headers cover the allowlist's refusal and a panic's 500, and the
// shell is served before the Auth middleware, which would ask for a session.
func TestHandlerServesTheWebBeforeAuthWithHeadersOnEveryAnswer(t *testing.T) {
	web, err := httpx.Web(webDir(t))
	if err != nil {
		t.Fatal(err)
	}
	authCalled := false
	h := httpx.NewHandler(httpx.Options{
		Logger:       slog.New(slog.DiscardHandler),
		Ready:        func(context.Context) error { return nil },
		AllowedHosts: []string{"sipges.local"},
		Headers:      httpx.SecurityHeaders(httpx.SecurityOptions{HSTS: true}),
		Web:          web,
		Auth: []httpx.Middleware{func(http.Handler) http.Handler {
			return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				authCalled = true
				w.WriteHeader(http.StatusUnauthorized)
			})
		}},
	})
	get := func(host, path, accept string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(http.MethodGet, path, nil)
		r.Host = host
		r.Header.Set("Accept", accept)
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, r)
		return rec
	}
	shell := get("sipges.local", "/", "text/html")
	if shell.Code != http.StatusOK || authCalled {
		t.Fatalf("shell: %d, auth called %v", shell.Code, authCalled)
	}
	if got := shell.Header().Get("Strict-Transport-Security"); got == "" {
		t.Error("shell has no HSTS")
	}
	refused := get("attacker.example", "/", "text/html")
	if refused.Code != http.StatusBadRequest {
		t.Fatalf("foreign host: %d", refused.Code)
	}
	if got := refused.Header().Get("Content-Security-Policy"); got != httpx.APICSP {
		t.Errorf("foreign host CSP = %q", got)
	}
	api := get("sipges.local", "/api/registros", "application/json")
	if api.Code != http.StatusUnauthorized || !authCalled {
		t.Fatalf("api: %d, auth called %v", api.Code, authCalled)
	}
	if got := api.Header().Get("Cache-Control"); got != "no-store" {
		t.Errorf("api Cache-Control = %q", got)
	}
}
