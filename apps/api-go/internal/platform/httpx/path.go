package httpx

import (
	"context"
	"net/http"
	"net/url"
	"strings"
)

type pathKey struct{}

// CanonicalPath makes the Go API decide on the path the TypeScript API sees. @hono/node-server
// builds the request URL with WHATWG URL, which reads '\' as '/' and removes "." and ".."
// segments (also written %2e); Hono's c.req.path is then decodeURI of it, keeping the escapes of
// reserved characters such as %2F and %25. The middleware rewrites the request URL to that
// normalized form (so the router matches what Hono routes) and keeps the Hono path for
// RequestPath. Go's own r.URL.Path decodes %2F and keeps dot segments, so checks on it could
// treat /system%2Fauth%2Fme as a public path or /hooks/../system/x as a machine path.
func CanonicalPath() Middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			escaped := removeDotSegments(strings.ReplaceAll(rawPath(r), `\`, "/"))
			r2 := r.Clone(context.WithValue(r.Context(), pathKey{}, decodeURIPath(escaped)))
			if unescaped, err := url.PathUnescape(escaped); err == nil {
				r2.URL.Path, r2.URL.RawPath = unescaped, escaped
			} else {
				r2.URL.Path, r2.URL.RawPath = escaped, ""
			}
			next.ServeHTTP(w, r2)
		})
	}
}

// RequestPath is the path as Hono's c.req.path reads it; without CanonicalPath, r.URL.Path.
func RequestPath(r *http.Request) string {
	if p, ok := r.Context().Value(pathKey{}).(string); ok {
		return p
	}
	return r.URL.Path
}

// HasEmptySegment reports a path such as //system/auth/me, which Hono routes as is (no route
// matches) while Go's ServeMux would redirect it to its cleaned form.
func HasEmptySegment(r *http.Request) bool {
	return strings.Contains(r.URL.EscapedPath(), "//")
}

// rawPath is the request target's path exactly as the client sent it.
func rawPath(r *http.Request) string {
	target := r.RequestURI
	if target == "" || !strings.HasPrefix(target, "/") {
		return r.URL.EscapedPath() // absolute-form targets and handler tests
	}
	if i := strings.IndexAny(target, "?#"); i >= 0 {
		target = target[:i]
	}
	return target
}

func isDot(segment string) bool { return segment == "." || strings.EqualFold(segment, "%2e") }

func isDoubleDot(segment string) bool {
	switch strings.ToLower(segment) {
	case "..", ".%2e", "%2e.", "%2e%2e":
		return true
	}
	return false
}

// removeDotSegments is the WHATWG URL path parser's handling of "." and ".." segments.
func removeDotSegments(path string) string {
	segments := strings.Split(strings.TrimPrefix(path, "/"), "/")
	out := make([]string, 0, len(segments))
	for i, segment := range segments {
		last := i == len(segments)-1
		switch {
		case isDoubleDot(segment):
			if len(out) > 0 {
				out = out[:len(out)-1]
			}
			if last {
				out = append(out, "")
			}
		case isDot(segment):
			if last {
				out = append(out, "")
			}
		default:
			out = append(out, segment)
		}
	}
	return "/" + strings.Join(out, "/")
}

// reservedInURI are the characters decodeURI leaves escaped, plus '%' itself (getPath doubles
// %25 so that it survives).
const reservedInURI = ";/?:@&=+$,#%"

// decodeURIPath is Hono's tryDecodeURI on the path: decodeURI, or when that throws, each run of
// %XX sequences decoded on its own, kept as is when it is not valid UTF-8.
func decodeURIPath(s string) string {
	if !strings.Contains(s, "%") {
		return s
	}
	if decoded, ok := decodeURI(s); ok {
		return decoded
	}
	return percentRun.ReplaceAllStringFunc(s, func(run string) string {
		if decoded, ok := decodeURI(run); ok {
			return decoded
		}
		return run
	})
}

// decodeURI is JavaScript's decodeURI: like decodeURIComponent, but an escape of a reserved
// character stays escaped.
func decodeURI(s string) (string, bool) {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		if s[i] != '%' {
			b.WriteByte(s[i])
			continue
		}
		if i+2 >= len(s) {
			return "", false
		}
		escape := s[i : i+3]
		decoded, ok := decodeURIComponent(escape)
		switch {
		case ok && len(decoded) == 1 && strings.ContainsRune(reservedInURI, rune(decoded[0])):
			b.WriteString(escape)
			i += 2
		case ok:
			b.WriteString(decoded)
			i += 2
		default:
			// A multi-byte character: take every continuation escape with it.
			end := i + 3
			for end+2 < len(s) && s[end] == '%' && isContinuation(s[end+1:end+3]) {
				end += 3
			}
			decoded, ok := decodeURIComponent(s[i:end])
			if !ok {
				return "", false
			}
			b.WriteString(decoded)
			i = end - 1
		}
	}
	return b.String(), true
}

// isContinuation reports a hex pair for a UTF-8 continuation byte (10xxxxxx).
func isContinuation(hexPair string) bool {
	if len(hexPair) != 2 {
		return false
	}
	c := strings.ToLower(hexPair)[0]
	return c == '8' || c == '9' || c == 'a' || c == 'b'
}
