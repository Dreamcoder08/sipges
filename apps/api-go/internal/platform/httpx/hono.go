package httpx

import (
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"
)

// The helpers in this file read a request the way the TypeScript API (Hono on @hono/node-server)
// does, so that every gate keyed on a path, cookie, query parameter or header decides the same
// thing in both APIs. Where an exact port would need the whole WHATWG URL parser, they keep to a
// subset and fail closed: a value they cannot read the same way is treated as absent or foreign.

// validRequestURL and dotSegment are @hono/node-server's checks: a request target outside them
// goes through `new URL`, which percent-encodes some bytes and resolves dot segments.
var (
	validRequestURL = regexp.MustCompile(`^/[!#$&-;=?-\[\]_a-z~]*$`)
	dotSegment      = regexp.MustCompile(`/\.\.?(?:[/?#]|$)`)
)

var upperToken = regexp.MustCompile(`^[A-Z]+$`)

// CanonicalPath replaces r.URL.Path with the path Hono's c.req.path would give, before any
// other middleware runs, so the gates and the router read one and the same string: a gate can
// never see one path while the router dispatches another.
func CanonicalPath() Middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if !upperToken.MatchString(r.Method) {
				// Node's parser refuses such methods before Hono sees them.
				http.Error(w, "Bad Request", http.StatusBadRequest)
				return
			}
			path := HonoPath(r)
			if path != r.URL.Path || r.URL.RawPath != "" {
				u := *r.URL
				u.Path, u.RawPath = path, ""
				r2 := r.Clone(r.Context())
				r2.URL = &u
				r = r2
			}
			next.ServeHTTP(w, r)
		})
	}
}

// HonoPath is c.req.path for this request: the raw target, normalized like `new URL` when
// @hono/node-server would build one, then decoded like Hono's getPath (decodeURI, %25 kept).
func HonoPath(r *http.Request) string {
	target, _, _ := strings.Cut(r.RequestURI, "#") // Hono's getPath stops at '#'
	if !strings.HasPrefix(target, "/") {
		target = r.URL.EscapedPath()
		if r.URL.RawQuery != "" {
			target += "?" + r.URL.RawQuery
		}
	}
	path, _, _ := strings.Cut(target, "?")
	if !validRequestURL.MatchString(target) || dotSegment.MatchString(target) {
		path = whatwgPath(path)
	}
	if !strings.Contains(path, "%") {
		return path
	}
	return tryDecode(strings.ReplaceAll(path, "%25", "%2525"), true)
}

// whatwgPath percent-encodes the bytes of the WHATWG path percent-encode set, turns '\' into
// '/' (http and https are special schemes) and resolves single- and double-dot segments,
// including their percent-encoded spellings.
func whatwgPath(raw string) string {
	var b strings.Builder
	for i := 0; i < len(raw); i++ {
		c := raw[i]
		switch {
		case c == '\\':
			b.WriteByte('/')
		case c <= 0x20 || c >= 0x7f || strings.IndexByte("\"#<>?`{}", c) >= 0:
			b.WriteString("%" + strings.ToUpper(hexByte(c)))
		default:
			b.WriteByte(c)
		}
	}
	segments := strings.Split(strings.TrimPrefix(b.String(), "/"), "/")
	out := make([]string, 0, len(segments))
	for i, seg := range segments {
		last := i == len(segments)-1
		switch {
		case isDoubleDot(seg):
			if len(out) > 0 {
				out = out[:len(out)-1]
			}
			if last {
				out = append(out, "")
			}
		case isSingleDot(seg):
			if last {
				out = append(out, "")
			}
		default:
			out = append(out, seg)
		}
	}
	return "/" + strings.Join(out, "/")
}

func isSingleDot(s string) bool { return s == "." || strings.EqualFold(s, "%2e") }

func isDoubleDot(s string) bool {
	switch strings.ToLower(s) {
	case "..", ".%2e", "%2e.", "%2e%2e":
		return true
	}
	return false
}

func hexByte(c byte) string {
	const digits = "0123456789abcdef"
	return string([]byte{digits[c>>4], digits[c&0x0f]})
}

// uriReserved is what decodeURI leaves encoded (ECMA-262 reservedURISet plus '#').
const uriReserved = ";/?:@&=+$,#"

// decodeStrict is decodeURIComponent (keepReserved false) or decodeURI (true): every '%' must
// start a valid escape and the escaped bytes must be well-formed UTF-8, or it fails.
func decodeStrict(s string, keepReserved bool) (string, bool) {
	var b strings.Builder
	for i := 0; i < len(s); {
		if s[i] != '%' {
			b.WriteByte(s[i])
			i++
			continue
		}
		start := i
		var buf []byte
		for i < len(s) && s[i] == '%' {
			v, ok := unhex(s, i)
			if !ok {
				return "", false
			}
			buf = append(buf, v)
			i += 3
			if utf8.FullRune(buf) {
				break
			}
		}
		r, size := utf8.DecodeRune(buf)
		if (r == utf8.RuneError && size <= 1) || size != len(buf) {
			return "", false
		}
		if keepReserved && size == 1 && strings.IndexByte(uriReserved, buf[0]) >= 0 {
			b.WriteString(s[start:i])
			continue
		}
		b.Write(buf)
	}
	return b.String(), true
}

func unhex(s string, i int) (byte, bool) {
	if i+2 >= len(s) {
		return 0, false
	}
	hi, ok1 := hexValue(s[i+1])
	lo, ok2 := hexValue(s[i+2])
	return hi<<4 | lo, ok1 && ok2
}

func hexValue(c byte) (byte, bool) {
	switch {
	case '0' <= c && c <= '9':
		return c - '0', true
	case 'a' <= c && c <= 'f':
		return c - 'a' + 10, true
	case 'A' <= c && c <= 'F':
		return c - 'A' + 10, true
	}
	return 0, false
}

var escapeRun = regexp.MustCompile(`(?:%[0-9A-Fa-f]{2})+`)

// tryDecode is Hono's tryDecode: decode the whole string, or else each run of escapes on its
// own, keeping the runs that do not decode.
func tryDecode(s string, keepReserved bool) string {
	if out, ok := decodeStrict(s, keepReserved); ok {
		return out
	}
	return escapeRun.ReplaceAllStringFunc(s, func(run string) string {
		if out, ok := decodeStrict(run, keepReserved); ok {
			return out
		}
		return run
	})
}

// tryDecodeComponent is Hono's tryDecodeURIComponent.
func tryDecodeComponent(s string) string {
	if !strings.Contains(s, "%") {
		return s
	}
	return tryDecode(s, false)
}

// Header is c.req.header(name): every field line of that name joined with ", ", as the Fetch
// Headers object does, so a repeated header never reads as just its first value.
func Header(r *http.Request, name string) (string, bool) {
	values := r.Header.Values(name)
	if len(values) == 0 {
		return "", false
	}
	return strings.Join(values, ", "), true
}

var (
	cookieName  = regexp.MustCompile(`^[!#-:<>-\[\]-~]+$`)
	cookieValue = regexp.MustCompile(`^[ !#-:<-\[\]-~]*$`)
)

// Cookie is Hono's getCookie(c, name): the first well-formed pair with that name in the Cookie
// header (Node joins repeated Cookie lines with "; "), unquoted and URI-decoded.
func Cookie(r *http.Request, name string) (string, bool) {
	header := strings.Join(r.Header.Values("Cookie"), "; ")
	if !strings.Contains(header, name) {
		return "", false
	}
	for _, pair := range strings.Split(header, ";") {
		key, value, found := strings.Cut(pair, "=")
		if !found {
			continue
		}
		key = strings.Trim(key, " \t")
		if key != name || !cookieName.MatchString(key) {
			continue
		}
		value = strings.Trim(value, " \t")
		if strings.HasPrefix(value, `"`) && strings.HasSuffix(value, `"`) {
			value = value[1:max(1, len(value)-1)] // a lone '"' unquotes to "", as in Hono
		}
		if cookieValue.MatchString(value) {
			return tryDecodeComponent(value), true
		}
	}
	return "", false
}

// QueryParam is c.req.query(key): the first parameter whose decoded name is key, with '+' read
// as a space and the value URI-decoded; a key without '=' has the empty value.
func QueryParam(r *http.Request, key string) (string, bool) {
	query := r.URL.RawQuery
	if strings.HasPrefix(r.RequestURI, "/") {
		target, _, _ := strings.Cut(r.RequestURI, "#") // Hono drops the fragment first
		_, query, _ = strings.Cut(target, "?")
	}
	if query == "" && !strings.Contains(r.RequestURI, "?") {
		return "", false
	}
	for _, part := range strings.Split(query, "&") {
		name, value, hasValue := strings.Cut(part, "=")
		name = decodeQuery(name)
		if name == "" || name != key {
			continue
		}
		if !hasValue {
			return "", true
		}
		return decodeQuery(value), true
	}
	return "", false
}

func decodeQuery(s string) string {
	return tryDecodeComponent(strings.ReplaceAll(s, "+", " "))
}

// conservativeHost is the only host form an Origin or Referer may carry to be compared; any
// other spelling (backslashes, escapes, IDN) is treated as no source at all. Userinfo is
// dropped as `new URL` does; both take the authority after the last '@'.
var conservativeHost = regexp.MustCompile(`^[A-Za-z0-9.\-]+(?::[0-9]+)?$|^\[[0-9A-Fa-f:.]+\](?::[0-9]+)?$`)

var defaultPorts = map[string]string{"http": "80", "https": "443", "ws": "80", "wss": "443", "ftp": "21"}

// originHost is `new URL(value).host` for the URLs a browser sends as Origin or Referer, lower
// case, without the scheme's default port. Anything else yields false (fail closed).
func originHost(value string) (string, bool) {
	if value == "" || value == "null" || strings.ContainsAny(value, "\\\t\r\n ") {
		return "", false
	}
	u, err := url.Parse(value)
	if err != nil || u.Scheme == "" || u.Opaque != "" || u.Host == "" {
		return "", false
	}
	host := strings.ToLower(u.Host)
	if !conservativeHost.MatchString(host) {
		return "", false
	}
	// new URL reads the port as a number (leading zeros dropped, above 65535 an error) and
	// drops the scheme's default port.
	if p := u.Port(); p != "" {
		n, err := strconv.Atoi(p)
		if err != nil || n > 65535 {
			return "", false
		}
		host = strings.TrimSuffix(host, ":"+p)
		if strconv.Itoa(n) != defaultPorts[strings.ToLower(u.Scheme)] {
			host += ":" + strconv.Itoa(n)
		}
	}
	return host, true
}

var readMethods = map[string]bool{http.MethodGet: true, http.MethodHead: true, http.MethodOptions: true}

// IsWriteMethod is origin.ts isWriteMethod: anything but GET, HEAD and OPTIONS.
func IsWriteMethod(method string) bool { return !readMethods[method] }

// OriginAllowed is origin.ts originAllowed: the Origin header, or Referer when Origin is
// missing or unreadable, must name this request's Host.
func OriginAllowed(r *http.Request) bool {
	if r.Host == "" {
		return false
	}
	origin, _ := Header(r, "Origin")
	source, ok := originHost(origin)
	if !ok {
		referer, _ := Header(r, "Referer")
		source, ok = originHost(referer)
	}
	return ok && source == strings.ToLower(r.Host)
}

// ForbiddenOrigin is origin.ts forbiddenOrigin.
func ForbiddenOrigin(w http.ResponseWriter) {
	WriteError(w, http.StatusForbidden, "Origen de solicitud no permitido")
}
