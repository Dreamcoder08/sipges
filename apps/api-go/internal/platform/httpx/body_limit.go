package httpx

import (
	"bytes"
	"io"
	"net/http"
)

// BodyTooLargeDetail is the 413 of the TypeScript API's generic body limits.
const BodyTooLargeDetail = "Cuerpo demasiado grande"

// WithinBodyLimit is the check of hono/body-limit: a declared Content-Length is trusted (the
// server never reads past it) and a body without one is read as it streams, stopping one byte
// past max. It leaves a body within the limit readable again, read error included, so the
// handler sees what it would have seen. It writes nothing: the caller owns the 413.
func WithinBodyLimit(r *http.Request, max int64) bool {
	if r.Body == nil || r.Body == http.NoBody {
		return true
	}
	if r.ContentLength >= 0 && len(r.TransferEncoding) == 0 {
		return r.ContentLength <= max
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, max+1))
	if int64(len(body)) > max {
		return false
	}
	var read io.Reader = bytes.NewReader(body)
	if err != nil {
		read = io.MultiReader(read, failingReader{err})
	}
	r.Body = io.NopCloser(read)
	r.ContentLength = int64(len(body))
	return true
}

type failingReader struct{ err error }

func (f failingReader) Read([]byte) (int, error) { return 0, f.err }

// BodyLimit refuses a request whose body passes max with the JSON 413 of BodyTooLargeDetail, so
// no handler can hold more than max bytes of it. Methods the TypeScript API reads no body on
// pass, and so do the paths exempt reports: those must bound the body themselves.
func BodyLimit(max int64, exempt func(path string) bool) Middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if IsWriteMethod(r.Method) && !exempt(r.URL.Path) && !WithinBodyLimit(r, max) {
				WriteJSONText(w, http.StatusRequestEntityTooLarge, ErrorBody{Detail: BodyTooLargeDetail})
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}
