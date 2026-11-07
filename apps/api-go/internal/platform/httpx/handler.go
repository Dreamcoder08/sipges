package httpx

import (
	"context"
	"log/slog"
	"net/http"
	"strings"
	"time"
)

// ReadyFunc reports whether the database answers.
type ReadyFunc func(ctx context.Context) error

// DefaultReadyTimeout matches the TypeScript API: a slow database counts as down, so the
// deploy smoke test never hangs on it.
const DefaultReadyTimeout = 5 * time.Second

// Options configures NewHandler.
type Options struct {
	Logger       *slog.Logger
	Ready        ReadyFunc
	ReadyTimeout time.Duration
	AllowedHosts []string
	AccessLog    bool
	// Headers wraps every response from outside Recover and the allowlist; nil behind the Worker,
	// which adds its own. Web answers the built SPA before Auth; nil without a web directory.
	Headers Middleware
	Web     Middleware
	// Auth runs after the host allowlist and before routing: the session, project scope and
	// role gates. Without it every route is public (unit tests of this package).
	Auth []Middleware
	// Routes adds the bounded contexts' routes to the mux.
	Routes func(mux *http.ServeMux)
	// Metrics counts every request and serves GET /system/metrics; nil turns off both.
	Metrics *Metrics
}

// healthBody is the static liveness body, field for field (and in order) the TypeScript API's
// HealthResponse from packages/contracts.
type healthBody struct {
	Status  string `json:"status"`
	Service string `json:"service"`
	Version string `json:"version"`
}

type readyBody struct {
	Status string `json:"status"`
}

var health = healthBody{Status: "ok", Service: "SIPGES", Version: "V0.5.1"}

// NewHandler builds the API handler: /health, /health/ready and whatever opts.Routes adds. No
// production route moves to Go before its parity test (docs/adr/0032 §6).
func NewHandler(opts Options) http.Handler {
	timeout := opts.ReadyTimeout
	if timeout <= 0 {
		timeout = DefaultReadyTimeout
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, _ *http.Request) {
		WriteJSON(w, http.StatusOK, health)
	})
	mux.HandleFunc("GET /health/ready", func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), timeout)
		defer cancel()
		if err := opts.Ready(ctx); err != nil {
			// The cause may carry a connection string: it is never echoed or logged.
			WriteJSON(w, http.StatusServiceUnavailable, readyBody{Status: "unavailable"})
			return
		}
		WriteJSON(w, http.StatusOK, readyBody{Status: "ready"})
	})
	if opts.Metrics != nil {
		mux.HandleFunc("GET /system/metrics", metricsRoute(opts.Metrics))
	}
	if opts.Routes != nil {
		opts.Routes(mux)
	}
	// Unknown paths and methods answer the JSON 404 of the other APIs, not ServeMux's text 405.
	notFound := func(w http.ResponseWriter, _ *http.Request) { WriteError(w, http.StatusNotFound, "Not Found") }
	mux.HandleFunc("/", notFound)
	// Hono routes a path with an empty segment (//x, /x//) as is and nothing matches it;
	// ServeMux would redirect it to its cleaned form, so it gets the JSON 404 here.
	routes := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.EscapedPath(), "//") {
			notFound(w, r)
			return
		}
		mux.ServeHTTP(w, r)
	})
	// CanonicalPath first: logs, gates and the router all read the path Hono would.
	middleware := []Middleware{CanonicalPath(), RequestID()}
	if opts.Metrics != nil {
		middleware = append(middleware, ObserveRequests(opts.Metrics, func(r *http.Request) string {
			if strings.Contains(r.URL.EscapedPath(), "//") {
				return unmatchedRoute
			}
			_, pattern := mux.Handler(r)
			return routeLabel(pattern)
		}))
	}
	if opts.AccessLog {
		middleware = append(middleware, AccessLog(opts.Logger))
	}
	if opts.Headers != nil {
		middleware = append(middleware, opts.Headers)
	}
	middleware = append(middleware, Recover(opts.Logger), HostAllowlist(opts.AllowedHosts))
	if opts.Web != nil {
		middleware = append(middleware, opts.Web)
	}
	middleware = append(middleware, opts.Auth...)
	return Chain(routes, middleware...)
}
