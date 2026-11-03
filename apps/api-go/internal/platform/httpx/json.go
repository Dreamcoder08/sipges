// Package httpx holds the HTTP basics shared by every route: the JSON error contract of
// docs/adr/0007, request ids, access logs, panic recovery, the host allowlist, health checks
// and graceful shutdown.
package httpx

import (
	"encoding/json"
	"net/http"
)

// ErrorBody is the error contract kept from the Python and TypeScript APIs: {"detail": …}.
type ErrorBody struct {
	Detail any `json:"detail"`
}

// WriteJSON writes v as JSON with status.
func WriteJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v) // the status is already sent; a failed write has no recovery
}

// WriteError writes {"detail": detail} with status.
func WriteError(w http.ResponseWriter, status int, detail any) {
	WriteJSON(w, status, ErrorBody{Detail: detail})
}
