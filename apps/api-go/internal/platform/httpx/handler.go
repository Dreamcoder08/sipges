package httpx

import (
	"context"
	"log/slog"
	"net/http"
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
	// Routes registers the bounded contexts' routes (identity, …) on the mux.
	Routes func(mux *http.ServeMux)
	// Pipeline runs after the host allowlist and before routing, for every path the mux would
	// see, unknown ones included: session, tenancy and role gate, as createApp's middleware.
	Pipeline []Middleware
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

// NewHandler builds the API handler: /health, /health/ready, the routes of opts.Routes and a JSON
// 404 for anything else. No production route moves to Go before its parity test (docs/adr/0032 §6).
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
	if opts.Routes != nil {
		opts.Routes(mux)
	}
	// Unknown paths and methods answer the JSON 404 of the other APIs, not ServeMux's text 405.
	mux.HandleFunc("/", func(w http.ResponseWriter, _ *http.Request) {
		WriteError(w, http.StatusNotFound, "Not Found")
	})
	middleware := []Middleware{RequestID()}
	if opts.AccessLog {
		middleware = append(middleware, AccessLog(opts.Logger))
	}
	middleware = append(middleware, Recover(opts.Logger), HostAllowlist(opts.AllowedHosts))
	middleware = append(middleware, opts.Pipeline...)
	return Chain(mux, middleware...)
}
