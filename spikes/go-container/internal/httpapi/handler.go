// Package httpapi exposes the spike over HTTP.
package httpapi

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/dreamcoder08/sipges/spikes/go-container/internal/dbping"
)

// Placement describes where Cloudflare placed the container, from its env.
type Placement struct {
	Location string `json:"location,omitempty"`
	Region   string `json:"region,omitempty"`
	Country  string `json:"country,omitempty"`
}

// Deps are the handler's collaborators.
type Deps struct {
	Targets   map[string]dbping.Connector // "direct", "pooled", ...
	Placement Placement
	StartedAt time.Time
	Now       func() time.Time
	Logger    *slog.Logger
	// TraceURL returns Cloudflare's key=value trace (e.g.
	// https://www.cloudflare.com/cdn-cgi/trace); its colo names the edge
	// where the container's outbound traffic leaves Cloudflare.
	TraceURL   string
	HTTPClient *http.Client
	// PingDeadline bounds one /db-ping run (connect plus queries) so an
	// unreachable host answers 504 before the server's write timeout.
	PingDeadline time.Duration
}

const (
	defaultTarget       = "direct"
	defaultQueries      = 50
	defaultPingDeadline = 30 * time.Second
)

// New returns the HTTP handler.
func New(deps Deps) http.Handler {
	if deps.PingDeadline <= 0 {
		deps.PingDeadline = defaultPingDeadline
	}
	if deps.Logger == nil {
		deps.Logger = slog.New(slog.DiscardHandler)
	}
	h := handler{deps: deps}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", h.health)
	mux.HandleFunc("GET /db-ping", h.dbPing)
	mux.HandleFunc("GET /egress", h.egress)
	return mux
}

type handler struct {
	deps Deps
}

type healthBody struct {
	Status    string    `json:"status"`
	UptimeMs  float64   `json:"uptimeMs"`
	StartedAt time.Time `json:"startedAt"`
	Placement Placement `json:"placement"`
}

func (h handler) health(w http.ResponseWriter, _ *http.Request) {
	uptime := h.deps.Now().Sub(h.deps.StartedAt)
	writeJSON(w, http.StatusOK, healthBody{
		Status:    "ok",
		UptimeMs:  float64(uptime) / float64(time.Millisecond),
		StartedAt: h.deps.StartedAt,
		Placement: h.deps.Placement,
	})
}

type dbPingBody struct {
	Target    string    `json:"target"`
	Placement Placement `json:"placement"`
	dbping.Result
}

func (h handler) dbPing(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()
	target := query.Get("target")
	if target == "" {
		target = defaultTarget
	}
	connector, ok := h.deps.Targets[target]
	if !ok {
		writeError(w, http.StatusBadRequest, "unknown_target", "target must name a configured database url")
		return
	}
	n := defaultQueries
	if raw := query.Get("n"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid_count", "n must be an integer")
			return
		}
		n = parsed
	}

	ctx, cancel := context.WithTimeout(r.Context(), h.deps.PingDeadline)
	defer cancel()
	result, err := dbping.Run(ctx, connector, n, time.Now)
	switch {
	case errors.Is(err, dbping.ErrInvalidCount):
		writeError(w, http.StatusBadRequest, "invalid_count", err.Error())
	case errors.Is(err, context.DeadlineExceeded):
		h.deps.Logger.ErrorContext(r.Context(), "db ping timed out", "target", target, "error", err)
		writeError(w, http.StatusGatewayTimeout, "database_timeout", err.Error())
	case err != nil:
		h.deps.Logger.ErrorContext(r.Context(), "db ping failed", "target", target, "error", err)
		writeError(w, http.StatusBadGateway, "database_unreachable", err.Error())
	default:
		writeJSON(w, http.StatusOK, dbPingBody{Target: target, Placement: h.deps.Placement, Result: result})
	}
}

type egressBody struct {
	Colo      string  `json:"colo"`
	Loc       string  `json:"loc"`
	ElapsedMs float64 `json:"elapsedMs"`
}

func (h handler) egress(w http.ResponseWriter, r *http.Request) {
	start := time.Now()
	fields, err := h.trace(r)
	if err != nil {
		h.deps.Logger.ErrorContext(r.Context(), "egress trace failed", "error", err)
		writeError(w, http.StatusBadGateway, "trace_unavailable", err.Error())
		return
	}
	// The egress IP stays out of the response on purpose.
	writeJSON(w, http.StatusOK, egressBody{
		Colo:      fields["colo"],
		Loc:       fields["loc"],
		ElapsedMs: float64(time.Since(start)) / float64(time.Millisecond),
	})
}

func (h handler) trace(r *http.Request) (map[string]string, error) {
	req, err := http.NewRequestWithContext(r.Context(), http.MethodGet, h.deps.TraceURL, nil)
	if err != nil {
		return nil, fmt.Errorf("build trace request: %w", err)
	}
	resp, err := h.deps.HTTPClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("trace request: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("trace status %d", resp.StatusCode)
	}
	fields := map[string]string{}
	scanner := bufio.NewScanner(io.LimitReader(resp.Body, 4096))
	for scanner.Scan() {
		if key, value, ok := strings.Cut(scanner.Text(), "="); ok {
			fields[key] = value
		}
	}
	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("read trace: %w", err)
	}
	return fields, nil
}

type errorBody struct {
	Error struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

func writeError(w http.ResponseWriter, status int, code, message string) {
	var body errorBody
	body.Error.Code = code
	body.Error.Message = message
	writeJSON(w, status, body)
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body) // the status is already sent; nothing useful to do on failure
}
