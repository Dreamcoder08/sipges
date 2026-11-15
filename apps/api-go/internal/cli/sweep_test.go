package cli

import (
	"net/http"
	"testing"
)

// A read that relays an external service answers 502 or 504 when that service is down (a site
// that stops answering, a laptop without internet): the sweep must not call that a broken read,
// while every other server error, and the same status on any other route, still is one.
func TestSweepToleratesAGatewayAnswerOnlyFromAnUpstreamRead(t *testing.T) {
	upstream := Route{Method: http.MethodGet, Path: "/system/intelligence/sources/defensoria/preview", Access: AccessSession, Upstream: true}
	local := Route{Method: http.MethodGet, Path: "/system/irsa", Access: AccessSession}
	cases := []struct {
		route  Route
		status int
		broken bool
	}{
		{upstream, http.StatusBadGateway, false},
		{upstream, http.StatusGatewayTimeout, false},
		{upstream, http.StatusInternalServerError, true},
		{upstream, http.StatusServiceUnavailable, true},
		{upstream, 0, true},
		{upstream, http.StatusOK, false},
		{local, http.StatusBadGateway, true},
		{local, http.StatusGatewayTimeout, true},
		{local, http.StatusInternalServerError, true},
		{local, 0, true},
		{local, http.StatusNotFound, false},
	}
	for _, tc := range cases {
		if got := brokenRead(tc.route, tc.status); got != tc.broken {
			t.Errorf("brokenRead(%s %s, %d) = %v, want %v", tc.route.Method, tc.route.Path, tc.status, got, tc.broken)
		}
	}
}

func TestTheDefensoriaPreviewIsMarkedAsAnUpstreamRead(t *testing.T) {
	routes, err := Routes()
	if err != nil {
		t.Fatal(err)
	}
	upstream := 0
	for _, route := range routes {
		if route.Upstream {
			upstream++
			if route.Method != http.MethodGet {
				t.Errorf("%s %s: only reads are swept, so only a read can be marked upstream", route.Method, route.Path)
			}
		}
		if route.Path == "/system/intelligence/sources/defensoria/preview" && !route.Upstream {
			t.Errorf("%s %s relays www.defensoria.gob.pe and must be marked upstream", route.Method, route.Path)
		}
	}
	if upstream == 0 {
		t.Error("no route is marked upstream")
	}
}
