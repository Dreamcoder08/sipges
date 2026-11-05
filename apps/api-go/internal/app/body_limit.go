package app

import "strings"

// ownBodyLimit lists the paths that bound the body themselves, each with an answer of its own
// that the global limit must not replace: evidence and the document lab (their upload limits,
// up to 200 MiB), identity (1 MiB, then the 422 of the route) and the public webhooks (64 and
// 512 KiB, enforced before their API key is checked, so an anonymous body is never buffered up
// to the global limit first). The project check stops at httpx.MaxRequestBody on these too. A
// route with a smaller limit needs no entry when that limit runs before the global one.
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
	return strings.HasPrefix(path, "/hooks/") ||
		strings.HasPrefix(path, "/system/auth/accounts/") && strings.HasSuffix(path, "/google")
}
