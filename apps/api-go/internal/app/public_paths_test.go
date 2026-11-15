package app_test

import (
	"context"
	"log/slog"
	"maps"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/app"
)

// publicWithoutSession is what answers 200 with no session cookie (functional-10 T9, risk item
// 2): the files public-paths.test.ts lists for the TypeScript API. /health/ready is left out
// because it pings the database, which this test never reaches.
var publicWithoutSession = []string{
	"/favicon.ico",
	"/favicon.svg",
	"/robots.txt",
	"/manifest.webmanifest",
	"/sw.js",
	"/icon.svg",
	"/assets/index-abc123.js",
	"/assets/index-abc123.css",
	"/cesium/Workers/worker.js",
	"/health",
	// The sign-in screen asks who is signed in (nobody) and which sign-in methods exist.
	"/system/auth/me",
	"/system/auth/providers",
}

// protectedWithoutSession is a sample of other paths with the status each answers without a
// session, unchanged by T9.
var protectedWithoutSession = map[string]int{
	"/":                          http.StatusUnauthorized,
	"/inicio":                    http.StatusUnauthorized,
	"/index.html":                http.StatusUnauthorized,
	"/api/eventos":               http.StatusUnauthorized,
	"/system/model-status":       http.StatusUnauthorized,
	"/system/auth/scopes":        http.StatusUnauthorized,
	"/favicon.png":               http.StatusUnauthorized,
	"/apple-touch-icon.png":      http.StatusUnauthorized,
	"/robots":                    http.StatusUnauthorized,
	"/sitemap.xml":               http.StatusUnauthorized,
	"/assets/index-abc123.js.br": http.StatusNotFound,
	"/assets/index-abc123.js.gz": http.StatusNotFound,
	"/assets/missing.js":         http.StatusNotFound,
}

// publicHandler is the real Go handler serving a synthetic build. Nothing connects: the pool
// dials on first use and no request here gets past the session check to a query.
func publicHandler(t *testing.T) http.Handler {
	t.Helper()
	t.Setenv("SIPGES_DATA_KEY", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=")
	dir := t.TempDir()
	for name, body := range map[string]string{
		"index.html":                 "<!doctype html><title>shell</title>",
		"favicon.ico":                "ico",
		"favicon.svg":                "<svg/>",
		"robots.txt":                 "User-agent: *\nDisallow: /\n",
		"manifest.webmanifest":       "{}",
		"sw.js":                      "self.x=1",
		"icon.svg":                   "<svg/>",
		"assets/index-abc123.js":     "ok()",
		"assets/index-abc123.js.br":  "br bytes",
		"assets/index-abc123.js.gz":  "gzip bytes",
		"assets/index-abc123.css":    "a{}",
		"cesium/Workers/worker.js":   "w()",
		"secret.txt":                 "never served",
		"cesium/Workers/nested/x.js": "w",
	} {
		path := filepath.Join(dir, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	pool, err := pgxpool.New(context.Background(), "postgres://synthetic@127.0.0.1:1/synthetic")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	h, err := app.NewHandler(pool, app.Options{Logger: slog.New(slog.DiscardHandler), WebDir: dir})
	if err != nil {
		t.Fatal(err)
	}
	return h
}

func statusOf(t *testing.T, h http.Handler, path, accept string) int {
	t.Helper()
	r := httptest.NewRequestWithContext(t.Context(), http.MethodGet, path, nil)
	r.Host = "localhost"
	if accept != "" {
		r.Header.Set("Accept", accept)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, r)
	return rec.Code
}

func TestOnlyTheListedPathsArePublicWithoutASession(t *testing.T) {
	h := publicHandler(t)
	candidates := append(slices.Clone(publicWithoutSession), slices.Sorted(maps.Keys(protectedWithoutSession))...)
	var public []string
	for _, path := range candidates {
		status := statusOf(t, h, path, "*/*")
		if status == http.StatusOK {
			public = append(public, path)
			continue
		}
		if want, sample := protectedWithoutSession[path]; sample && status != want {
			t.Errorf("%s: %d, want %d", path, status, want)
		}
	}
	if !slices.Equal(public, publicWithoutSession) {
		t.Errorf("public without a session:\n got %q\nwant %q", public, publicWithoutSession)
	}
}

// A browser navigation gets the shell whatever the client route; the API's paths never do.
func TestNavigationsGetTheShellAndTheAPIKeepsItsSession(t *testing.T) {
	h := publicHandler(t)
	for path, want := range map[string]int{
		"/":                    http.StatusOK,
		"/inicio":              http.StatusOK,
		"/login":               http.StatusOK,
		"/registros/alertas":   http.StatusOK,
		"/api/eventos":         http.StatusUnauthorized,
		"/system/model-status": http.StatusUnauthorized,
	} {
		if got := statusOf(t, h, path, "text/html,application/xhtml+xml"); got != want {
			t.Errorf("%s: %d, want %d", path, got, want)
		}
	}
}
