package httpx

import (
	"bytes"
	"io"
	"net/http"
)

// BodyTooLargeDetail is the 413 of the TypeScript API's generic body limits.
const BodyTooLargeDetail = "Cuerpo demasiado grande"

// MaxRequestBody is the global limit on a request body. The TypeScript API has none: only the
// routes with their own hono/body-limit are bounded there. This is the Go API's own choice, set
// by the largest body the contracts accept unbounded: POST /system/import/{module} takes up to
// 2000 rows of free text (packages/contracts/src/records.ts), and 16 MiB leaves 8 KiB per row.
const MaxRequestBody = 16 << 20

// WithinBodyLimit is the check of hono/body-limit as the routes with a limit of their own use
// it: a body that cannot be read counts as empty. It writes nothing: the caller owns the 413.
func WithinBodyLimit(r *http.Request, max int64) bool {
	within, err := keepWithin(r, max)
	if err != nil {
		r.Body = http.NoBody
		r.ContentLength = 0
	}
	return within
}

// keepWithin is hono/body-limit: a declared Content-Length is trusted (the server never reads
// past it) and a body without one is read as it streams, stopping one byte past max. A body
// within the limit stays readable, read error included.
func keepWithin(r *http.Request, max int64) (bool, error) {
	if r.Body == nil || r.Body == http.NoBody {
		return true, nil
	}
	if r.ContentLength >= 0 && len(r.TransferEncoding) == 0 {
		return r.ContentLength <= max, nil
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, max+1))
	if int64(len(body)) > max {
		return false, nil
	}
	var read io.Reader = bytes.NewReader(body)
	if err != nil {
		read = io.MultiReader(read, failingReader{err})
	}
	r.Body = io.NopCloser(read)
	r.ContentLength = int64(len(body))
	return true, err
}

type failingReader struct{ err error }

func (f failingReader) Read([]byte) (int, error) { return 0, f.err }

// PeekBody reads the body for a check that runs before the route, leaving it readable. A body
// past max is not returned (whole is false) and stays complete for the route's own limit, so
// the check never holds more than max. A read error is returned with the bytes read, which are
// all a later reader gets.
func PeekBody(r *http.Request, max int64) (body []byte, whole bool, err error) {
	body, err = io.ReadAll(io.LimitReader(r.Body, max+1))
	if int64(len(body)) > max {
		r.Body = struct {
			io.Reader
			io.Closer
		}{io.MultiReader(bytes.NewReader(body), r.Body), r.Body}
		return nil, false, nil
	}
	r.Body = io.NopCloser(bytes.NewReader(body))
	return body, true, err
}

// BodyLimit refuses a request whose body passes max with the JSON 413 of BodyTooLargeDetail, so
// no handler can hold more than max bytes of it. Methods the TypeScript API reads no body on
// pass, and so do the paths exempt reports: those must bound the body themselves. A body that
// fails to read reaches the handler as it would without this limit.
func BodyLimit(max int64, exempt func(path string) bool) Middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if IsWriteMethod(r.Method) && !exempt(r.URL.Path) {
				if within, _ := keepWithin(r, max); !within {
					WriteJSONText(w, http.StatusRequestEntityTooLarge, ErrorBody{Detail: BodyTooLargeDetail})
					return
				}
			}
			next.ServeHTTP(w, r)
		})
	}
}
