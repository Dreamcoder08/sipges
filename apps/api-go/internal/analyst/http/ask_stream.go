package http

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"time"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/analyst/domain"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/httpx"
)

// POST /system/analyst/ask/stream (odd/tasks/chat-first-ui.md T10): the question of /ask, with the
// same session, role, project scope, row-level security, egress guard, body and limits, answered
// as server-sent events so the screen can say what the analyst is doing:
//
//	event: step    {"label": "Buscando registros…"}, once per tool call, never its input or result
//	event: answer  the body /ask answers, once the citations are checked
//	event: error   {"status": 502, "detail": "…"}, the status and text /ask would answer with
//	event: done    {}
//
// The answer text is not streamed as the model writes it (L3): its markers are checked on the
// whole answer, and a partial one could show claims that are then refused. A client that goes away
// ends the loop through the request context; nothing more is sent and it is logged as 499.

// defaultHeartbeat is the quiet time after which the stream sends a comment line.
const defaultHeartbeat = 15 * time.Second

type stepJSON struct {
	Label string `json:"label"`
}

type streamErrorJSON struct {
	Status int    `json:"status"`
	Detail string `json:"detail"`
}

// stepRelay hands each step to the handler, which alone writes the response. It gives up when the
// question ends, so a loop that stops never waits on it.
type stepRelay struct {
	ctx   context.Context //nolint:containedctx // the question's lifetime, for one relay
	steps chan<- string
}

func (s stepRelay) ToolStep(label string) {
	select {
	case s.steps <- label:
	case <-s.ctx.Done():
	}
}

type askOutcome struct {
	answer domain.CitedAnswer
	err    error
}

func askStreamRoute(opts Options) http.HandlerFunc {
	heartbeat := opts.Heartbeat
	if heartbeat <= 0 {
		heartbeat = defaultHeartbeat
	}
	return func(w http.ResponseWriter, r *http.Request) {
		// Read before the first write: HTTP/1.x may close the body once the answer starts.
		question, valid := readQuestion(r)
		ctx, cancel := context.WithCancel(r.Context())
		defer cancel()

		rc := http.NewResponseController(w)
		h := w.Header()
		h.Set("Content-Type", "text/event-stream")
		h.Set("Cache-Control", "no-cache")
		h.Set("X-Accel-Buffering", "no")
		w.WriteHeader(http.StatusOK)
		_ = rc.Flush()

		open := true
		send := func(frame string) {
			if !open {
				return
			}
			// Fixed event names and JSON-encoded data: never read as HTML.
			if _, err := io.WriteString(w, frame); err != nil || rc.Flush() != nil {
				open = false
				cancel() // the client is gone: stop the loop
			}
		}
		event := func(name string, data any) {
			body, err := json.Marshal(data)
			if err != nil {
				body = []byte("{}")
			}
			send(fmt.Sprintf("event: %s\ndata: %s\n\n", name, body))
		}

		steps := make(chan string)
		done := make(chan askOutcome, 1)
		go func() {
			answer, err := answerQuestion(ctx, opts, question, valid, stepRelay{ctx: ctx, steps: steps})
			done <- askOutcome{answer, err}
		}()

		quiet := time.NewTicker(heartbeat)
		defer quiet.Stop()
		for {
			select {
			case label := <-steps:
				event("step", stepJSON{Label: label})
				quiet.Reset(heartbeat)
			case <-quiet.C:
				send(": ping\n\n")
			case out := <-done:
				status, detail := http.StatusOK, ""
				if out.err != nil {
					status, detail = askFailure(out.err)
				}
				if ctx.Err() != nil || status == StatusClientClosed {
					logStreamClosed(r, opts)
					return
				}
				if out.err != nil {
					logAskFailure(r, opts, status, out.err)
					event("error", streamErrorJSON{Status: status, Detail: detail})
				} else {
					event("answer", toAskJSON(out.answer))
				}
				event("done", struct{}{})
				return
			}
		}
	}
}

// logStreamClosed records a stream its client left, as the access log records /ask's 499: the
// stream already answered 200, so the access log cannot.
func logStreamClosed(r *http.Request, opts Options) {
	if opts.Logger == nil {
		return
	}
	opts.Logger.LogAttrs(r.Context(), slog.LevelInfo, "analyst_ask_stream_closed",
		slog.Int("status", StatusClientClosed), slog.String("request_id", httpx.RequestIDFrom(r.Context())))
}
