package httpx

import (
	"fmt"
	"strings"
)

// AuthCookie is setAuthCookie of cookies.ts through Hono's serialize, the Set-Cookie value: Path=/
// and SameSite=Strict (ADR 0004).
func AuthCookie(name, value string, secure bool, maxAge int) string {
	return ScopedCookie(name, value, secure, maxAge, "/", "Strict")
}

// ScopedCookie is Hono's setCookie with httpOnly: the value encodeURIComponent-encoded, then
// Max-Age, Path, HttpOnly, Secure and SameSite, in that order.
func ScopedCookie(name, value string, secure bool, maxAge int, path, sameSite string) string {
	var out strings.Builder
	fmt.Fprintf(&out, "%s=%s; Max-Age=%d; Path=%s; HttpOnly", name, EncodeURIComponent(value), maxAge, path)
	if secure {
		out.WriteString("; Secure")
	}
	out.WriteString("; SameSite=" + sameSite)
	return out.String()
}

// EncodeURIComponent keeps A-Z a-z 0-9 - _ . ! ~ * ' ( ) and percent-encodes every other UTF-8
// byte in upper-case hex.
func EncodeURIComponent(s string) string {
	var out strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		if (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || strings.IndexByte("-_.!~*'()", c) >= 0 {
			out.WriteByte(c)
			continue
		}
		fmt.Fprintf(&out, "%%%02X", c)
	}
	return out.String()
}
