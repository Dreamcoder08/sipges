package httpx

import "net/http"

// PathParam is c.req.param(name) for a ServeMux wildcard: the segment of the Hono path (already
// decoded by CanonicalPath, with reserved escapes such as %2F kept), decoded once more like
// Hono's tryDecodeURIComponent when it holds a '%'.
func PathParam(r *http.Request, name string) string {
	return tryDecodeComponent(r.PathValue(name))
}
