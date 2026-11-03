package http_test

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	geographyhttp "github.com/Dreamcoder08/sipges/apps/api-go/internal/geography/http"
)

// Ported from apps/api/test/geography/http.test.ts (oversized bodies) and hono/body-limit's
// rules: a declared Content-Length is trusted, a body without one is counted as it streams.

const tooLarge = `{"detail":"Consulta demasiado extensa"}`

// echo answers the body it received, proving the limit hands it on intact.
var echo = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
	b, _ := io.ReadAll(r.Body)
	_, _ = w.Write(b)
})

// counting is a body of unknown length that records how much was read.
type counting struct {
	read, size int
}

func (c *counting) Read(p []byte) (int, error) {
	if c.read >= c.size {
		return 0, io.EOF
	}
	n := min(len(p), c.size-c.read, 60_000)
	for i := range n {
		p[i] = 'x'
	}
	c.read += n
	return n, nil
}

func serve(r *http.Request) *httptest.ResponseRecorder {
	w := httptest.NewRecorder()
	geographyhttp.RequestLimit()(echo).ServeHTTP(w, r)
	return w
}

func TestRequestLimit(t *testing.T) {
	const path = "/system/geography/query"
	t.Run("a declared length over 100 000 bytes", func(t *testing.T) {
		w := serve(httptest.NewRequest(http.MethodPost, path, strings.NewReader(strings.Repeat(" ", 100_001))))
		if w.Code != http.StatusRequestEntityTooLarge || w.Body.String() != tooLarge || w.Header().Get("Content-Type") != "application/json" {
			t.Fatalf("%d %q %q", w.Code, w.Body.String(), w.Header().Get("Content-Type"))
		}
	})
	t.Run("exactly 100 000 bytes pass intact", func(t *testing.T) {
		body := strings.Repeat("y", 100_000)
		if w := serve(httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))); w.Code != http.StatusOK || w.Body.String() != body {
			t.Fatalf("%d, %d bytes", w.Code, w.Body.Len())
		}
	})
	t.Run("a streamed body is cut early", func(t *testing.T) {
		src := &counting{size: 600_000}
		r := httptest.NewRequest(http.MethodPost, path, src)
		r.ContentLength = -1
		r.Header.Del("Content-Length")
		r.TransferEncoding = []string{"chunked"}
		if w := serve(r); w.Code != http.StatusRequestEntityTooLarge || w.Body.String() != tooLarge {
			t.Fatalf("%d %q", w.Code, w.Body.String())
		}
		if src.read >= src.size {
			t.Fatal("the whole body was consumed")
		}
	})
	t.Run("a small streamed body passes intact", func(t *testing.T) {
		r := httptest.NewRequest(http.MethodPost, path, &counting{size: 70_000})
		r.ContentLength = -1
		if w := serve(r); w.Code != http.StatusOK || w.Body.Len() != 70_000 {
			t.Fatalf("%d, %d bytes", w.Code, w.Body.Len())
		}
	})
	t.Run("any method on the path", func(t *testing.T) {
		if w := serve(httptest.NewRequest(http.MethodPut, path, strings.NewReader(strings.Repeat(" ", 100_001)))); w.Code != http.StatusRequestEntityTooLarge {
			t.Fatalf("%d", w.Code)
		}
	})
	t.Run("other paths are not limited", func(t *testing.T) {
		for _, p := range []string{"/system/geography/query/", "/system/geography/catalogue", "/api/eventos"} {
			if w := serve(httptest.NewRequest(http.MethodPost, p, strings.NewReader(strings.Repeat(" ", 100_001)))); w.Code != http.StatusOK {
				t.Fatalf("%s: %d", p, w.Code)
			}
		}
	})
	t.Run("no body", func(t *testing.T) {
		if w := serve(httptest.NewRequest(http.MethodGet, path, nil)); w.Code != http.StatusOK {
			t.Fatalf("%d", w.Code)
		}
	})
}
