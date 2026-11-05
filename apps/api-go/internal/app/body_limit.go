package app

import "strings"

// maxRequestBody is the global limit on a request body. The TypeScript API has none: only the
// routes with their own hono/body-limit are bounded there. This is the Go API's own choice, set
// by the largest body the contracts accept unbounded: POST /system/import/{module} takes up to
// 2000 rows of free text (packages/contracts/src/records.ts), and 16 MiB leaves 8 KiB per row.
const maxRequestBody = 16 << 20

// ownBodyLimit lists the paths that bound the body themselves, each with an answer of its own
// that the global limit must not replace: evidence and the document lab (their upload limits,
// up to 200 MiB) and identity (1 MiB, then the 422 of the route). A route with a limit under
// maxRequestBody needs no entry when both refuse with the same answer or its limit runs first.
func ownBodyLimit(path string) bool {
	switch path {
	case "/system/uploads",
		"/system/document-lab/analyze",
		"/system/document-lab/report.docx",
		"/system/document-lab/compare",
		"/login",
		"/system/auth/accounts",
		"/system/auth/totp/enable":
		return true
	}
	return strings.HasPrefix(path, "/system/auth/accounts/") && strings.HasSuffix(path, "/google")
}
