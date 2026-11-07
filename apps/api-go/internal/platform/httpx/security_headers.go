package httpx

import (
	"net/http"
	"sync"
)

// APICSP is API_CSP of security-headers.ts: the API serves JSON and the server-rendered
// /select-project form (inline style attributes, no scripts), so nothing else may load.
const APICSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"

// Cache values of spa.ts: Vite hashes asset names, so they keep for a year; Cesium's names carry
// no hash, so they keep for a day.
const (
	AssetCache  = "public, max-age=31536000, s-maxage=31536000, immutable"
	CesiumCache = "public, max-age=86400"
)

// SecurityOptions configures SecurityHeaders.
type SecurityOptions struct {
	// HSTS is on when cookies are Secure, that is, the deployment is HTTPS (ADR 0004).
	HSTS bool
}

// SecurityHeaders is securityHeaders of security-headers.ts. Behind the Cloudflare Worker the
// Worker adds them, so only a host that serves Go directly (SIPGES_WEB_DIR) mounts this. They are
// applied when the response starts, because Go cannot change headers afterwards the way Hono can.
func SecurityHeaders(opts SecurityOptions) Middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			headers := &headerWriter{ResponseWriter: w, hsts: opts.HSTS}
			next.ServeHTTP(headers, r)
			headers.apply()
		})
	}
}

// headerWriter sets the headers once, before the first byte leaves.
type headerWriter struct {
	http.ResponseWriter
	hsts bool
	once sync.Once
}

func (h *headerWriter) apply() {
	h.once.Do(func() {
		set := h.Header()
		set.Set("X-Content-Type-Options", "nosniff")
		set.Set("X-Frame-Options", "DENY")
		if set.Get("Referrer-Policy") == "" {
			set.Set("Referrer-Policy", "no-referrer")
		}
		// Only SPA assets may be cached; everything else, API data included, is never stored.
		if cache := set.Get("Cache-Control"); cache != AssetCache && cache != CesiumCache {
			set.Set("Cache-Control", "no-store")
		}
		if set.Get("Content-Security-Policy") == "" {
			set.Set("Content-Security-Policy", APICSP)
		}
		set.Set("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
		if h.hsts {
			set.Set("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
		}
	})
}

// WriteHeader implements http.ResponseWriter.
func (h *headerWriter) WriteHeader(status int) {
	h.apply()
	h.ResponseWriter.WriteHeader(status)
}

func (h *headerWriter) Write(b []byte) (int, error) {
	h.apply()
	return h.ResponseWriter.Write(b)
}

// FlushError lets http.ResponseController flush through here: a flush sends the headers, and
// through Unwrap alone they would leave without these. The event stream depends on it.
func (h *headerWriter) FlushError() error {
	h.apply()
	return http.NewResponseController(h.ResponseWriter).Flush()
}

// Unwrap lets http.ResponseController reach the underlying writer (write deadlines).
func (h *headerWriter) Unwrap() http.ResponseWriter { return h.ResponseWriter }
