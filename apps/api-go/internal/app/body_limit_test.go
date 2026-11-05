package app

import "testing"

func TestOwnBodyLimitNamesOnlyRoutesThatBoundTheBody(t *testing.T) {
	for path, want := range map[string]bool{
		"/system/uploads":                      true,
		"/system/document-lab/analyze":         true,
		"/system/document-lab/report.docx":     true,
		"/system/document-lab/compare":         true,
		"/login":                               true,
		"/system/auth/accounts":                true,
		"/system/auth/accounts/ana/google":     true,
		"/system/auth/totp/enable":             true,
		"/system/document-lab/review/import":   false,
		"/system/auth/accounts/ana/deactivate": false,
		"/system/import/hechos":                false,
		"/system/tenants":                      false,
	} {
		if got := ownBodyLimit(path); got != want {
			t.Errorf("%s: %v", path, got)
		}
	}
}
