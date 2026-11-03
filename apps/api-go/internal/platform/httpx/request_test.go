package httpx_test

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/httpx"
)

// Cookie reproduces Hono's getCookie (hono/dist/utils/cookie.js parse + tryDecodeURIComponent).
func TestCookie(t *testing.T) {
	t.Parallel()
	cases := []struct {
		header, want string
		found        bool
	}{
		{"sipges_scope=SIPGES%2FPRJ-A", "SIPGES/PRJ-A", true},
		{"a=1; sipges_scope=X%2FY; sipges_scope=Z%2FW", "X/Y", true},
		{"sipges_scope=\"Q%2FR\"", "Q/R", true},
		{"  sipges_scope =  S%2FT  ", "S/T", true},
		{"sipges_scope=bad\\value; sipges_scope=OK", "OK", true},
		{"sipges_scope=100%", "100%", true},
		{"sipges_scope=%E0%A4%A; x=1", "%E0%A4%A", true},
		{"sipges_scope=%C3%A9%FF", "%C3%A9%FF", true},
		{"sipges_scope=%C3%A9-%FF", "é-%FF", true},
		{"sipges_scope=", "", true},
		{"other=1", "", false},
		{"sipges_scopex=1", "", false},
		{"", "", false},
	}
	for _, c := range cases {
		r := httptest.NewRequest(http.MethodGet, "/", nil)
		if c.header != "" {
			r.Header.Set("Cookie", c.header)
		}
		got, found := httpx.Cookie(r, "sipges_scope")
		if got != c.want || found != c.found {
			t.Errorf("Cookie(%q) = %q, %v; want %q, %v", c.header, got, found, c.want, c.found)
		}
	}
}

// QueryParam reproduces Hono's c.req.query(key): first occurrence, + as space, tolerant decoding.
func TestQueryParam(t *testing.T) {
	t.Parallel()
	cases := map[string]string{
		"/x?project_id=P1":                   "P1",
		"/x?a=1&project_id=P1&project_id=P2": "P1",
		"/x?project_id=a+b":                  "a b",
		"/x?project_id=%ZZ":                  "%ZZ",
		"/x?project_id":                      "",
		"/x?project_idx=1":                   "",
		"/x":                                 "",
		"/x?project_id=P%2F1":                "P/1",
	}
	for target, want := range cases {
		r := httptest.NewRequest(http.MethodGet, target, nil)
		if got := httpx.QueryParam(r, "project_id"); got != want {
			t.Errorf("QueryParam(%s) = %q, want %q", target, got, want)
		}
	}
}

// OriginAllowed reproduces apps/api/src/platform/http/origin.ts.
func TestOriginAllowed(t *testing.T) {
	t.Parallel()
	cases := []struct {
		host, origin, referer string
		want                  bool
	}{
		{"app.example:8443", "https://app.example:8443", "", true},
		{"APP.example", "https://app.EXAMPLE", "", true},
		{"app.example", "https://app.example:8443", "", false},
		{"app.example", "", "https://app.example/page", true},
		{"app.example", "null", "https://app.example/page", true},
		{"app.example", "not a url", "https://app.example/page", true},
		{"app.example", "https://evil.example", "https://app.example/page", false},
		{"app.example", "", "", false},
		{"app.example", "https://app.example:443", "", true},
	}
	// Two Origin headers read as one joined value, which no URL parser accepts, as in Fetch.
	two := httptest.NewRequest(http.MethodPost, "/", nil)
	two.Host = "app.example"
	two.Header.Add("Origin", "https://app.example")
	two.Header.Add("Origin", "https://evil.example")
	if httpx.OriginAllowed(two) {
		t.Error("two Origin headers must not pass")
	}
	for _, c := range cases {
		r := httptest.NewRequest(http.MethodPost, "/", nil)
		r.Host = c.host
		if c.origin != "" {
			r.Header.Set("Origin", c.origin)
		}
		if c.referer != "" {
			r.Header.Set("Referer", c.referer)
		}
		if got := httpx.OriginAllowed(r); got != c.want {
			t.Errorf("OriginAllowed(host=%s origin=%s referer=%s) = %v", c.host, c.origin, c.referer, got)
		}
	}
	for method, want := range map[string]bool{"GET": false, "HEAD": false, "OPTIONS": false, "POST": true, "DELETE": true, "PATCH": true} {
		if got := httpx.IsWriteMethod(method); got != want {
			t.Errorf("IsWriteMethod(%s) = %v", method, got)
		}
	}
}
