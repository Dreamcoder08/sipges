package httpx_test

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/httpx"
)

// Expected values computed with Node 22 (WHATWG URL as @hono/node-server builds it) and Hono 4.13.14
// getPath: dot segments removed (also %2e), '\' read as '/', then decodeURI keeping reserved escapes.
func TestCanonicalPath(t *testing.T) {
	t.Parallel()
	cases := []struct{ target, hono, escaped string }{
		{"/system/auth/me", "/system/auth/me", "/system/auth/me"},
		{"/system%2Fauth%2Fme", "/system%2Fauth%2Fme", "/system%2Fauth%2Fme"},
		{"/hooks%2Fx", "/hooks%2Fx", "/hooks%2Fx"},
		{"/hooks/../system/x", "/system/x", "/system/x"},
		{"/system/../system/auth/me", "/system/auth/me", "/system/auth/me"},
		{"//system/auth/me", "//system/auth/me", "//system/auth/me"},
		{"/a/./b", "/a/b", "/a/b"},
		{"/a/%2e/b", "/a/b", "/a/b"},
		{"/a/%2E%2e/b", "/b", "/b"},
		{"/a/.%2e/b", "/b", "/b"},
		{`/system\auth\me`, "/system/auth/me", "/system/auth/me"},
		{"/a%20b", "/a b", "/a%20b"},
		{"/caf%C3%A9", "/café", "/caf%C3%A9"},
		{"/a%25b", "/a%25b", "/a%25b"},
		{"/a%2525b", "/a%2525b", "/a%2525b"},
		// An invalid escape cannot be a Go RawPath: the router sees it re-escaped. Neither form
		// matches a route, so both APIs answer the pipeline's result or 404.
		{"/bad%E0%A4%A", "/bad%E0%A4%A", "/bad%25E0%25A4%25A"},
		{"/x%3Fy", "/x%3Fy", "/x%3Fy"},
		{"/x%23y", "/x%23y", "/x%23y"},
		{"/x%40y", "/x%40y", "/x%40y"},
		{"/x%41y", "/xAy", "/x%41y"},
		{"/a/..", "/", "/"},
		{"/a/.", "/a/", "/a/"},
		{"/a/b/../../..", "/", "/"},
		{"/..%2fsystem", "/..%2fsystem", "/..%2fsystem"},
		{"/system/auth/me?x=1", "/system/auth/me", "/system/auth/me"},
	}
	for _, c := range cases {
		var gotHono, gotEscaped string
		h := httpx.CanonicalPath()(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
			gotHono, gotEscaped = httpx.RequestPath(r), r.URL.EscapedPath()
		}))
		r := httptest.NewRequest(http.MethodGet, "http://app.example/", nil)
		r.RequestURI = c.target
		h.ServeHTTP(httptest.NewRecorder(), r)
		if gotHono != c.hono || gotEscaped != c.escaped {
			t.Errorf("%s: path %q escaped %q, want %q %q", c.target, gotHono, gotEscaped, c.hono, c.escaped)
		}
	}
}
