package httpx

import (
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// Ported from hono/body-limit's rules: a declared length is trusted, a body without one is
// counted as it streams and is refused as soon as it passes the limit.

const limit = 1000

const tooLargeBody = `{"detail":"Cuerpo demasiado grande"}`

// streamed is a body of unknown length that records how much was read and may end in an error.
type streamed struct {
	read, size int
	err        error
}

func (s *streamed) Read(p []byte) (int, error) {
	if s.read >= s.size {
		if s.err != nil {
			return 0, s.err
		}
		return 0, io.EOF
	}
	n := min(len(p), s.size-s.read, 64)
	for i := range n {
		p[i] = 'x'
	}
	s.read += n
	return n, nil
}

func chunked(method string, body *streamed) *http.Request {
	r := httptest.NewRequest(method, "/x", body)
	r.ContentLength = -1
	r.TransferEncoding = []string{"chunked"}
	return r
}

// serve answers the body the handler read, or what the read failed with.
func serve(r *http.Request, exempt func(string) bool) *httptest.ResponseRecorder {
	w := httptest.NewRecorder()
	BodyLimit(limit, exempt)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, err := io.ReadAll(r.Body)
		if err != nil {
			w.WriteHeader(http.StatusTeapot)
		}
		_, _ = w.Write(b)
	})).ServeHTTP(w, r)
	return w
}

func none(string) bool { return false }

func refused(t *testing.T, w *httptest.ResponseRecorder) {
	t.Helper()
	if w.Code != http.StatusRequestEntityTooLarge || w.Body.String() != tooLargeBody || w.Header().Get("Content-Type") != "application/json" {
		t.Fatalf("%d %q %q", w.Code, w.Body.String(), w.Header().Get("Content-Type"))
	}
}

func TestBodyLimit(t *testing.T) {
	t.Run("a declared length over the limit is refused unread", func(t *testing.T) {
		body := &streamed{size: limit + 1}
		r := httptest.NewRequest(http.MethodPost, "/x", io.LimitReader(body, limit+1))
		r.ContentLength = limit + 1
		refused(t, serve(r, none))
		if body.read != 0 {
			t.Fatalf("read %d bytes of a refused body", body.read)
		}
	})
	t.Run("a declared length at the limit passes intact", func(t *testing.T) {
		in := strings.Repeat("y", limit)
		if w := serve(httptest.NewRequest(http.MethodPost, "/x", strings.NewReader(in)), none); w.Code != http.StatusOK || w.Body.String() != in {
			t.Fatalf("%d, %d bytes", w.Code, w.Body.Len())
		}
	})
	t.Run("a stream over the limit stops being read just past it", func(t *testing.T) {
		body := &streamed{size: 100 * limit}
		refused(t, serve(chunked(http.MethodPut, body), none))
		if body.read > limit+64 {
			t.Fatalf("read %d bytes for a limit of %d", body.read, limit)
		}
	})
	t.Run("a stream at the limit passes intact", func(t *testing.T) {
		w := serve(chunked(http.MethodPatch, &streamed{size: limit}), none)
		if w.Code != http.StatusOK || w.Body.String() != strings.Repeat("x", limit) {
			t.Fatalf("%d, %d bytes", w.Code, w.Body.Len())
		}
	})
	t.Run("a stream that fails keeps its bytes and its error", func(t *testing.T) {
		w := serve(chunked(http.MethodPost, &streamed{size: 10, err: errors.New("cut")}), none)
		if w.Code != http.StatusTeapot || w.Body.String() != strings.Repeat("x", 10) {
			t.Fatalf("%d %q", w.Code, w.Body.String())
		}
	})
	t.Run("a stream that fails past the limit is still refused", func(t *testing.T) {
		refused(t, serve(chunked(http.MethodPost, &streamed{size: limit + 1, err: errors.New("cut")}), none))
	})
	t.Run("no body passes", func(t *testing.T) {
		if w := serve(httptest.NewRequest(http.MethodPost, "/x", http.NoBody), none); w.Code != http.StatusOK {
			t.Fatal(w.Code)
		}
	})
	for _, method := range []string{http.MethodGet, http.MethodHead, http.MethodOptions} {
		t.Run(method+" passes: TypeScript reads no body on it", func(t *testing.T) {
			if w := serve(httptest.NewRequest(method, "/x", strings.NewReader(strings.Repeat("y", limit+1))), none); w.Code != http.StatusOK {
				t.Fatal(w.Code)
			}
		})
	}
	t.Run("an exempt path passes, a neighbour does not", func(t *testing.T) {
		exempt := func(path string) bool { return path == "/own" }
		over := strings.Repeat("y", limit+1)
		if w := serve(httptest.NewRequest(http.MethodPost, "/own", strings.NewReader(over)), exempt); w.Code != http.StatusOK || w.Body.Len() != limit+1 {
			t.Fatalf("%d, %d bytes", w.Code, w.Body.Len())
		}
		refused(t, serve(httptest.NewRequest(http.MethodPost, "/own/x", strings.NewReader(over)), exempt))
	})
}
