package app

import "net/http"

// SetPushTransport makes the push sender reach its service through rt; the result restores it.
func SetPushTransport(rt http.RoundTripper) func() {
	previous := pushTransport
	pushTransport = rt
	return func() { pushTransport = previous }
}
