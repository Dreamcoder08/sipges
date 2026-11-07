package httpx_test

import (
	"bufio"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/httpx"
)

type honoCase struct {
	target    string
	headers   []string
	path      string
	projectID *string
	session   *string
	scope     *string
	originOK  bool
}

type echo struct {
	Path      string  `json:"path"`
	ProjectID *string `json:"project_id"`
	Session   *string `json:"session"`
	Scope     *string `json:"scope"`
	OriginOK  bool    `json:"origin_ok"`
}

func optional(v string, ok bool) *string {
	if !ok {
		return nil
	}
	return &v
}

// echoServer answers what the gates would read: the canonical path, the query parameter, both
// cookies and the Origin decision.
func echoServer(t *testing.T) string {
	t.Helper()
	h := httpx.Chain(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		httpx.WriteJSON(w, http.StatusOK, echo{
			Path:      r.URL.Path,
			ProjectID: optional(httpx.QueryParam(r, "project_id")),
			Session:   optional(httpx.Cookie(r, "sipges_session")),
			Scope:     optional(httpx.Cookie(r, "sipges_scope")),
			OriginOK:  httpx.OriginAllowed(r),
		})
	}), httpx.CanonicalPath())
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	return srv.Listener.Addr().String()
}

// rawGet sends the request target byte for byte, as the reference recording did; an HTTP
// client would normalize it first.
func rawGet(t *testing.T, addr, target string, headers []string) (int, []byte) {
	t.Helper()
	conn, err := net.Dial("tcp", addr)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = conn.Close() }()
	req := "GET " + target + " HTTP/1.1\r\nHost: h.example\r\n"
	for _, h := range headers {
		req += h + "\r\n"
	}
	if _, err := io.WriteString(conn, req+"Connection: close\r\n\r\n"); err != nil {
		t.Fatal(err)
	}
	res, err := http.ReadResponse(bufio.NewReader(conn), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = res.Body.Close() }()
	body, _ := io.ReadAll(res.Body)
	return res.StatusCode, body
}

// goRejects are request targets Go's server refuses with 400 before any handler (an invalid
// escape in the path), where Hono serves them: a difference that fails closed.
var goRejects = map[string]bool{"/system/a%C3%A1%ZZb": true, "/system/audit%": true}

func TestRequestReadingMatchesHono(t *testing.T) {
	addr := echoServer(t)
	for _, c := range honoCases {
		t.Run(c.target+" "+strings.Join(c.headers, " "), func(t *testing.T) {
			status, body := rawGet(t, addr, c.target, c.headers)
			if goRejects[c.target] {
				if status != http.StatusBadRequest {
					t.Fatalf("status %d, want Go's 400", status)
				}
				return
			}
			if status != http.StatusOK {
				t.Fatalf("status %d: %s", status, body)
			}
			var got echo
			if err := json.Unmarshal(body, &got); err != nil {
				t.Fatal(err)
			}
			want := echo{Path: c.path, ProjectID: c.projectID, Session: c.session, Scope: c.scope, OriginOK: c.originOK}
			if g, w := mustJSON(t, got), mustJSON(t, want); g != w {
				t.Errorf("got  %s\nwant %s", g, w)
			}
		})
	}
}

func mustJSON(t *testing.T, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// Spellings `new URL` reads but this port refuses: each must fail closed (no source), never
// read as this host.
func TestOriginFailsClosedOnUnusualSpellings(t *testing.T) {
	for _, origin := range []string{
		"https://evil.example\\@h.example",
		"https://h.example%2F@evil.example",
		"https://xn--h-example",
		"https://h.example\t",
		"https://evil.example#@h.example",
	} {
		r := httptest.NewRequest(http.MethodPost, "http://h.example/x", nil)
		r.Header.Set("Origin", origin)
		if httpx.OriginAllowed(r) {
			t.Errorf("%q accepted as h.example", origin)
		}
	}
}

func TestIsWriteMethod(t *testing.T) {
	for method, write := range map[string]bool{"GET": false, "HEAD": false, "OPTIONS": false, "POST": true, "PUT": true, "PATCH": true, "DELETE": true} {
		if httpx.IsWriteMethod(method) != write {
			t.Errorf("%s: write = %v", method, !write)
		}
	}
}

// Verifier findings on T8 (fail-open spellings): each must read as TypeScript reads it or fail
// closed.
func TestVerifierFindingsFailClosed(t *testing.T) {
	addr := echoServer(t)
	read := func(target string, headers ...string) echo {
		t.Helper()
		status, body := rawGet(t, addr, target, headers)
		if status != http.StatusOK {
			t.Fatalf("%s: status %d", target, status)
		}
		var e echo
		if err := json.Unmarshal(body, &e); err != nil {
			t.Fatal(err)
		}
		return e
	}
	// Hono unquotes a lone '"' to "" and stops at that first match.
	if e := read("/s", `Cookie: sipges_session="; sipges_session=abc`); e.Session == nil || *e.Session != "" {
		t.Errorf("lone quote: session %v, want \"\"", e.Session)
	}
	// Hono's getPath and getQueryParam stop at '#'.
	if e := read("/system/auth/current-scope#/../../../health"); e.Path != "/system/auth/current-scope" {
		t.Errorf("fragment path: %q", e.Path)
	}
	if e := read("/s?project_id=X#"); e.ProjectID == nil || *e.ProjectID != "X" {
		t.Errorf("fragment query: %v", e.ProjectID)
	}
	if e := read("/s?a#&project_id=X"); e.ProjectID != nil {
		t.Errorf("query after fragment: %v", *e.ProjectID)
	}
}

func TestOriginNormalizesPortsLikeNewURL(t *testing.T) {
	for _, c := range []struct {
		origin, host string
		ok           bool
	}{
		{"http://h.example:0080", "h.example:0080", false}, // new URL drops the default port
		{"http://h.example:0080", "h.example", true},
		{"https://h.example:08443", "h.example:8443", true},
		{"https://h.example:99999", "h.example:99999", false}, // new URL throws
	} {
		r := httptest.NewRequest(http.MethodPost, "http://"+c.host+"/x", nil)
		r.Header.Set("Origin", c.origin)
		if got := httpx.OriginAllowed(r); got != c.ok {
			t.Errorf("Origin %s, Host %s: %v, want %v", c.origin, c.host, got, c.ok)
		}
	}
}

// GHSA-jpvv-r467-5p4w: a raw backslash in the request path is a 400 with no body, before any
// handler, so a reverse proxy and this API can never read two different paths.
func TestRefusesABackslashInThePath(t *testing.T) {
	hits := 0
	h := httpx.Chain(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		hits++
		w.WriteHeader(http.StatusNoContent)
	}), httpx.CanonicalPath())
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	addr := srv.Listener.Addr().String()

	for _, target := range []string{
		`/system\auth\me`,
		`/hooks\..\system\x`,
		`/admin\secret?x=1`,
		`/a\b#fragment`,
		`/a#\b`,
		`http://h.example/a\b`,
	} {
		t.Run("refused "+target, func(t *testing.T) {
			hits = 0
			status, body := rawGet(t, addr, target, nil)
			if status != http.StatusBadRequest || len(body) != 0 || hits != 0 {
				t.Fatalf("status %d, body %q, handler ran %d times; want 400, empty, 0", status, body, hits)
			}
		})
	}
	for _, target := range []string{`/system%5Cauth`, `/system/x?q=\`, `/system/x?a=1\2`, `/a#?\b`} {
		t.Run("accepted "+target, func(t *testing.T) {
			hits = 0
			status, _ := rawGet(t, addr, target, nil)
			if status != http.StatusNoContent || hits != 1 {
				t.Fatalf("status %d, handler ran %d times; want 204 once", status, hits)
			}
		})
	}
}

// Node refuses methods that are not upper-case tokens before any handler runs.
func TestRefusesLowerCaseMethods(t *testing.T) {
	h := httpx.Chain(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		t.Fatal("handler ran")
	}), httpx.CanonicalPath())
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest(strings.ToLower(http.MethodPost), "/api/eventos", nil))
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status %d", w.Code)
	}
}
