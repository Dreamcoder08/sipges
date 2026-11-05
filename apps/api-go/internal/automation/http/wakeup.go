package http

import (
	"net/http"
	"strings"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/automation/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/httpx"
)

// Dispatcher is what Wakeup needs from the runtime.
type Dispatcher interface{ Dispatch(tenantID string) }

var _ Dispatcher = (*application.Runtime)(nil)

// wakesAutomation is the business test of automationWakeup: the paths whose successful writes
// change what rules may match. The machine paths (/hooks/ingest/*, /hooks/signals) are not
// served by the Go API.
func wakesAutomation(path string) bool {
	return strings.HasPrefix(path, "/api/") ||
		strings.HasPrefix(path, "/system/intelligence/territorial-alerts") ||
		strings.HasPrefix(path, "/system/intelligence/sources/") ||
		path == "/system/v4/media/poll" ||
		strings.HasPrefix(path, "/system/prevention/") ||
		strings.HasPrefix(path, "/system/automations/rules")
}

var writeMethods = map[string]bool{http.MethodPost: true, http.MethodPut: true, http.MethodPatch: true, http.MethodDelete: true}

// statusRecorder keeps the status the route wrote.
type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (s *statusRecorder) WriteHeader(code int) {
	if s.status == 0 {
		s.status = code
	}
	s.ResponseWriter.WriteHeader(code)
}

func (s *statusRecorder) Write(b []byte) (int, error) {
	if s.status == 0 {
		s.status = http.StatusOK
	}
	return s.ResponseWriter.Write(b)
}

// Unwrap lets http.ResponseController reach the server's writer.
func (s *statusRecorder) Unwrap() http.ResponseWriter { return s.ResponseWriter }

// Wakeup is automationWakeup of apps/api/src/platform/http/automation-wakeup.ts: after a 2xx
// write to a business path, the request's project gets a scan. It runs after the role gate,
// around the routes, as in apps/api/src/app.ts. Dispatch never waits for a tick another request
// started, and the tick it starts runs in the background (as the Worker's waitUntil), so the
// response is not delayed by it.
func Wakeup(runtime Dispatcher) httpx.Middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if !writeMethods[r.Method] {
				next.ServeHTTP(w, r)
				return
			}
			rec := &statusRecorder{ResponseWriter: w}
			next.ServeHTTP(rec, r)
			status := rec.status
			if status == 0 {
				status = http.StatusOK // a handler that wrote nothing answered 200
			}
			if status < 200 || status >= 300 || !wakesAutomation(r.URL.Path) {
				return
			}
			if tenant, ok := tenantOf(r); ok {
				runtime.Dispatch(tenant)
			}
		})
	}
}
