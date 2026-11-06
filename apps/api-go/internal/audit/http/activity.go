package http

import (
	"io"
	"log/slog"
	"math"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/audit/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/httpx"
)

// ActivityPath is the live activity stream (ACTIVITY_PATH of activity-routes.ts).
const ActivityPath = "/system/events"

// activityOptions are ActivityOptions of activity-routes.ts.
type activityOptions struct {
	// poll is how often the trail is read for new entries.
	poll time.Duration
	// max ends a stream; the browser reconnects with Last-Event-ID.
	max time.Duration
	// heartbeat is the quiet time after which a comment line keeps proxies from closing it.
	heartbeat time.Duration
}

// activityOptions are DEFAULTS of activity-routes.ts with the Deps overrides. Every poll is a
// tenant transaction held by each open tab, hence 10 s rather than a few.
func (d Deps) activityOptions() activityOptions {
	pick := func(v, def time.Duration) time.Duration {
		if v > 0 {
			return v
		}
		return def
	}
	return activityOptions{
		poll:      pick(d.ActivityPoll, 10*time.Second),
		max:       pick(d.ActivityMax, 240*time.Second),
		heartbeat: pick(d.ActivityHeartbeat, 25*time.Second),
	}
}

// streamAccess reports whether the request's session token still opens its project: the session
// and the grant, read fresh, never from the request's grant cache.
type streamAccess interface {
	StillAllowed(r *http.Request) (bool, error)
}

// activityBatch is BATCH: a full batch is followed by another poll without waiting.
const activityBatch = 100

type activityData struct {
	Module string `json:"module"`
	Action string `json:"action"`
}

// activityHandler is activityRoutes (docs/adr/0014 §10): server-sent events with the project's
// activity so open screens refresh themselves. Each event names only the module and action,
// never a record id or detail, so every role may listen. Those names still belong to the
// project, so the session and the grant are read again before every poll: a logout, an expired
// session, a deactivated account or a revoked grant ends the stream within one poll, and the
// browser's reconnection then meets the gates. A failed read ends the stream, as Hono's streamSSE
// does without an onError handler; the browser then reconnects.
func activityHandler(t trail, access streamAccess, opts activityOptions, log *slog.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rc := http.NewResponseController(w)
		// The stream outlives the server's read and write timeouts by design.
		until := time.Now().Add(opts.max + opts.poll + time.Minute)
		_ = rc.SetReadDeadline(until)
		_ = rc.SetWriteDeadline(until)
		h := w.Header()
		h.Set("Content-Type", "text/event-stream")
		h.Set("Cache-Control", "no-cache")
		h.Set("Connection", "keep-alive")
		w.WriteHeader(http.StatusOK)
		_ = rc.Flush()

		write := func(s string) bool {
			// text/event-stream of fixed names, ids and JSON-encoded fields: never read as HTML.
			if _, err := io.WriteString(w, s); err != nil { //nolint:gosec // see above
				return false
			}
			return rc.Flush() == nil
		}

		header, present := httpx.Header(r, "Last-Event-ID")
		cursor, ok := resumeCursor(header, present)
		if !ok {
			last, err := t.LastID(r)
			if err != nil {
				logReadFailure(r, log, err)
				return
			}
			cursor = last
		}
		if !write(sseEvent("ready", "{}", cursor)) {
			return
		}
		deadline := time.Now().Add(opts.max)
		var quiet time.Duration
		for r.Context().Err() == nil && time.Now().Before(deadline) {
			allowed, err := access.StillAllowed(r)
			if err != nil {
				logReadFailure(r, log, err)
				return
			}
			if !allowed {
				return
			}
			entries, err := t.After(r, cursor, application.AfterLimit(activityBatch))
			if err != nil {
				logReadFailure(r, log, err)
				return
			}
			for _, e := range entries {
				cursor = e.ID
				data, err := marshal(activityData{Module: e.Module, Action: e.Action})
				if err != nil || !write(sseEvent("activity", string(data), e.ID)) {
					return
				}
			}
			if len(entries) > 0 {
				quiet = 0
			} else {
				quiet += opts.poll
			}
			if quiet >= opts.heartbeat {
				if !write(": ping\n\n") {
					return
				}
				quiet = 0
			}
			if len(entries) < activityBatch {
				timer := time.NewTimer(opts.poll)
				select {
				case <-r.Context().Done():
					timer.Stop()
					return
				case <-timer.C:
				}
			}
		}
	}
}

// logReadFailure logs a failed trail read; the stream then ends.
func logReadFailure(r *http.Request, log *slog.Logger, err error) {
	if log != nil {
		log.LogAttrs(r.Context(), slog.LevelError, "activity stream read failed", slog.String("error", err.Error()),
			slog.String("request_id", httpx.RequestIDFrom(r.Context())))
	}
}

// sseEvent is Hono's writeSSE for one-line data.
func sseEvent(event, data string, id int64) string {
	return "event: " + event + "\ndata: " + data + "\nid: " + strconv.FormatInt(id, 10) + "\n\n"
}

var (
	jsDecimal    = regexp.MustCompile(`^[+-]?(?:Infinity|(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?)$`)
	jsNonDecimal = map[byte]int{'x': 16, 'X': 16, 'o': 8, 'O': 8, 'b': 2, 'B': 2}
)

// maxSafeInteger is Number.MAX_SAFE_INTEGER.
const maxSafeInteger = 1<<53 - 1

// resumeCursor reads Last-Event-ID as activity-routes.ts does: Number(header), kept when it is
// a safe non-negative integer. ok is false when the stream must start at the newest entry.
func resumeCursor(header string, present bool) (int64, bool) {
	if !present {
		return 0, false // Number(undefined) is NaN
	}
	s := strings.TrimFunc(header, isJSSpace)
	if s == "" {
		return 0, true // Number("") is 0
	}
	if len(s) > 2 && s[0] == '0' && jsNonDecimal[s[1]] != 0 {
		v, err := strconv.ParseUint(s[2:], jsNonDecimal[s[1]], 64)
		if err != nil || v > maxSafeInteger {
			return 0, false
		}
		return int64(v), true
	}
	if !jsDecimal.MatchString(s) {
		return 0, false
	}
	f, _ := strconv.ParseFloat(s, 64) // out of range reads as ±Inf or 0, as in JavaScript
	if math.IsInf(f, 0) || f != math.Trunc(f) || f < 0 || f > maxSafeInteger {
		return 0, false
	}
	return int64(f), true
}
