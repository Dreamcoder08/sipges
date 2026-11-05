package httpx

import (
	"fmt"
	"strings"
)

// AuthCookie is setAuthCookie of cookies.ts through Hono's serialize, the Set-Cookie value: the
// value encodeURIComponent-encoded, then Max-Age, Path, HttpOnly, Secure and SameSite, in that
// order (ADR 0004).
func AuthCookie(name, value string, secure bool, maxAge int) string {
	var out strings.Builder
	fmt.Fprintf(&out, "%s=", name)
	for i := 0; i < len(value); i++ {
		c := value[i]
		if (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || strings.IndexByte("-_.!~*'()", c) >= 0 {
			out.WriteByte(c)
			continue
		}
		fmt.Fprintf(&out, "%%%02X", c)
	}
	fmt.Fprintf(&out, "; Max-Age=%d; Path=/; HttpOnly", maxAge)
	if secure {
		out.WriteString("; Secure")
	}
	out.WriteString("; SameSite=Strict")
	return out.String()
}
