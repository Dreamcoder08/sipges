package app

import "net/http"

// EgressGuard exposes the guard's composition to the integration tests.
var EgressGuard = egressGuard

// SetGoogleTransport makes the composition reach Google through rt; the result restores it.
func SetGoogleTransport(rt http.RoundTripper) func() {
	previous := googleTransport
	googleTransport = rt
	return func() { googleTransport = previous }
}
