package httpx

import "net/http"

// PathParam is c.req.param(name): the ServeMux wildcard of the canonical path (CanonicalPath),
// decoded with Hono's tryDecodeURIComponent, so escapes decodeURI kept in the path (%2F, %23,
// %25, …) reach the handler decoded, as in the TypeScript route.
func PathParam(r *http.Request, name string) string {
	return tryDecodeComponent(r.PathValue(name))
}
