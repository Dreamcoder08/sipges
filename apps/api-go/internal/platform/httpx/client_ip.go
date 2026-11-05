package httpx

import (
	"net"
	"net/http"
	"strings"
)

// ClientIPOptions says which addresses a deployment may believe; forwarded headers are spoofable
// unless a trusted proxy sets them.
type ClientIPOptions struct {
	// EdgeHeader reads CF-Connecting-IP only, as the Worker's clientIp does: Cloudflare's edge
	// sets it on every request and clients cannot override it. For the container behind the
	// Worker, which nothing else can reach.
	EdgeHeader bool
	// TrustProxy is SIPGES_TRUST_PROXY: read X-Forwarded-For from a trusted reverse proxy.
	TrustProxy bool
}

// ClientIP is the client address for throttling. With EdgeHeader it is hosting-cloudflare's
// `c.req.header('cf-connecting-ip') ?? 'unknown'`; otherwise resolveClientIp of main.ts: with
// TrustProxy the right-most X-Forwarded-For entry, the one the proxy appended for the connection
// it received, else the socket address.
func ClientIP(r *http.Request, opts ClientIPOptions) string {
	if opts.EdgeHeader {
		if ip, ok := Header(r, "CF-Connecting-IP"); ok {
			return string(latin1ToUTF8(ip))
		}
		return "unknown"
	}
	if forwarded, ok := Header(r, "X-Forwarded-For"); ok && opts.TrustProxy {
		hops := strings.Split(forwarded, ",")
		for i := len(hops) - 1; i >= 0; i-- {
			if hop := trimBytes(hops[i], isJSTrimByte); hop != "" {
				return string(latin1ToUTF8(hop))
			}
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil || host == "" {
		return "unknown"
	}
	return host
}
