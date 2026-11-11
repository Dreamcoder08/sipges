// Package apitest holds the HTTP helpers the per-context integration tests share: a composed
// handler over a scratch database, a JSON GET with a session cookie, and an exact-match check.
// Every account and row the tests use is synthetic.
package apitest

import (
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/app"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/database/dbtest"
)

// Start serves the composed handler over the scratch database with a fixed clock and returns its
// base URL; it skips the test when no scratch database is configured.
func Start(t *testing.T, scratch *dbtest.Scratch, now time.Time) string {
	t.Helper()
	if scratch == nil {
		t.Skip(dbtest.EnvAdminURL + " is not set")
	}
	pool, err := pgxpool.New(t.Context(), scratch.URL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	h, err := app.NewHandler(pool, app.Options{
		Logger: slog.New(slog.DiscardHandler),
		Now:    func() time.Time { return now },
	})
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	return srv.URL
}

// Get issues a GET, with the session cookie when token is not empty, and returns the status and
// the trimmed JSON body.
func Get(t *testing.T, base, path, token string, headers map[string]string) (int, string) {
	t.Helper()
	r, err := http.NewRequestWithContext(t.Context(), http.MethodGet, base+path, nil)
	if err != nil {
		t.Fatal(err)
	}
	if token != "" {
		r.Header.Set("Cookie", "sipges_session="+token)
	}
	for k, v := range headers {
		r.Header.Set(k, v)
	}
	res, err := http.DefaultClient.Do(r)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = res.Body.Close() }()
	b, _ := io.ReadAll(res.Body)
	if ct := res.Header.Get("Content-Type"); !strings.HasPrefix(ct, "application/json") {
		t.Fatalf("%s: content-type %q", path, ct)
	}
	return res.StatusCode, strings.TrimSpace(string(b))
}

// Expect stops the test unless the status and body are exactly the expected ones.
func Expect(t *testing.T, gotStatus int, gotBody string, status int, body string) {
	t.Helper()
	if gotStatus != status || gotBody != body {
		t.Fatalf("got  %d %s\nwant %d %s", gotStatus, gotBody, status, body)
	}
}
