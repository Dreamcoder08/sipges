package httpx

import (
	"encoding/hex"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"unicode/utf8"
)

// The request readers below reproduce what the TypeScript API (Hono) sees, so both APIs take the
// same decision on the same bytes: getCookie, c.req.query and platform/http/origin.ts.

// validCookieValue is Hono's validCookieValueRegEx: printable ASCII except '"', ';' and '\'.
var validCookieValue = regexp.MustCompile(`^[ !#-:<-\[\]-~]*$`)

// Cookie returns the first valid value of the named cookie, decoded like Hono's getCookie.
func Cookie(r *http.Request, name string) (string, bool) {
	header := strings.Join(r.Header.Values("Cookie"), "; ")
	for pair := range strings.SplitSeq(header, ";") {
		key, value, ok := strings.Cut(pair, "=")
		if !ok || strings.Trim(key, " \t") != name {
			continue
		}
		value = strings.Trim(value, " \t")
		if len(value) >= 2 && strings.HasPrefix(value, `"`) && strings.HasSuffix(value, `"`) {
			value = value[1 : len(value)-1]
		}
		if validCookieValue.MatchString(value) {
			return tryDecodeURIComponent(value), true
		}
	}
	return "", false
}

// QueryParam is Hono's c.req.query(key): the first `key=value` (or bare `key`) of the raw query,
// with '+' as a space and tolerant percent-decoding; "" when absent.
func QueryParam(r *http.Request, key string) string {
	for pair := range strings.SplitSeq(r.URL.RawQuery, "&") {
		name, value, _ := strings.Cut(pair, "=")
		if name == key {
			return tryDecodeURIComponent(strings.ReplaceAll(value, "+", " "))
		}
	}
	return ""
}

// HeaderValue is Fetch's Headers.get: every value of the header joined with ", ".
func HeaderValue(r *http.Request, name string) string {
	return strings.Join(r.Header.Values(name), ", ")
}

var percentRun = regexp.MustCompile(`(?:%[0-9A-Fa-f]{2})+`)

// tryDecodeURIComponent is Hono's: decodeURIComponent, or when that throws, each run of %XX
// sequences decoded on its own and kept as is if it is not valid UTF-8.
func tryDecodeURIComponent(s string) string {
	if !strings.Contains(s, "%") {
		return s
	}
	if decoded, ok := decodeURIComponent(s); ok {
		return decoded
	}
	return percentRun.ReplaceAllStringFunc(s, func(run string) string {
		if decoded, ok := decodeURIComponent(run); ok {
			return decoded
		}
		return run
	})
}

// decodeURIComponent fails, like JavaScript's, on a malformed escape or invalid UTF-8.
func decodeURIComponent(s string) (string, bool) {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		if s[i] != '%' {
			b.WriteByte(s[i])
			continue
		}
		if i+2 >= len(s) {
			return "", false
		}
		decoded, err := hex.DecodeString(s[i+1 : i+3])
		if err != nil {
			return "", false
		}
		b.Write(decoded)
		i += 2
	}
	out := b.String()
	return out, utf8.ValidString(out)
}

// IsWriteMethod reports any method but GET, HEAD and OPTIONS.
func IsWriteMethod(method string) bool {
	return method != "GET" && method != "HEAD" && method != "OPTIONS"
}

var defaultPorts = map[string]string{"http": "80", "https": "443", "ws": "80", "wss": "443", "ftp": "21"}

// hostOf is origin.ts hostOf: the host (with a non-default port) of an absolute URL, or false
// for an empty value, the literal "null" or anything WHATWG URL would refuse.
func hostOf(value string) (string, bool) {
	if value == "" || value == "null" {
		return "", false
	}
	u, err := url.Parse(value)
	if err != nil || u.Scheme == "" {
		return "", false
	}
	host := strings.ToLower(u.Host)
	if port := u.Port(); port != "" && defaultPorts[strings.ToLower(u.Scheme)] == port {
		host = strings.TrimSuffix(host, ":"+port)
	}
	return host, true
}

// OriginAllowed is origin.ts originAllowed: the Origin host (or the Referer's when Origin is
// missing or unparseable) equals the Host header, ignoring case.
func OriginAllowed(r *http.Request) bool {
	if r.Host == "" {
		return false
	}
	source, ok := hostOf(r.Header.Get("Origin"))
	if !ok {
		source, ok = hostOf(r.Header.Get("Referer"))
	}
	return ok && source == strings.ToLower(r.Host)
}
