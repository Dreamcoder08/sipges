//nolint:misspell // Spanish record modules and messages in synthetic fixtures.
package http_test

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/analyst/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/analyst/domain"
	analysthttp "github.com/Dreamcoder08/sipges/apps/api-go/internal/analyst/http"
	privacy "github.com/Dreamcoder08/sipges/apps/api-go/internal/privacy/application"
	tenancydomain "github.com/Dreamcoder08/sipges/apps/api-go/internal/tenancy/domain"
	tenancyhttp "github.com/Dreamcoder08/sipges/apps/api-go/internal/tenancy/http"
)

// POST /system/analyst/ask/stream (odd/tasks/chat-first-ui.md T10): the same question as /ask,
// answered as server-sent events: a step per tool call, then one answer or one error, then done.

const streamPath = "/system/analyst/ask/stream"

type sseEvent struct{ name, data string }

// parseEvents reads a text/event-stream body; comments (heartbeats) are skipped.
func parseEvents(t *testing.T, body string) []sseEvent {
	t.Helper()
	var events []sseEvent
	for _, block := range strings.Split(body, "\n\n") {
		var event sseEvent
		for _, line := range strings.Split(block, "\n") {
			switch {
			case line == "" || strings.HasPrefix(line, ":"):
			case strings.HasPrefix(line, "event: "):
				event.name = strings.TrimPrefix(line, "event: ")
			case strings.HasPrefix(line, "data: "):
				event.data = strings.TrimPrefix(line, "data: ")
			default:
				t.Fatalf("unexpected stream line %q in %q", line, body)
			}
		}
		if event.name != "" {
			events = append(events, event)
		}
	}
	return events
}

func scoped(ctx context.Context) context.Context {
	return tenancyhttp.WithScope(ctx, tenancydomain.Scope{CompanyID: "ACME", ProjectID: "NORTE"})
}

func askStream(t *testing.T, opts analysthttp.Options, body string) (*httptest.ResponseRecorder, []sseEvent) {
	t.Helper()
	mux := http.NewServeMux()
	analysthttp.Routes(mux, opts)
	req := httptest.NewRequestWithContext(scoped(t.Context()), http.MethodPost, streamPath, strings.NewReader(body))
	res := httptest.NewRecorder()
	mux.ServeHTTP(res, req)
	return res, parseEvents(t, res.Body.String())
}

// recordingTools answers every call with its records and keeps the names it was called with.
type recordingTools struct {
	mu    sync.Mutex
	refs  []domain.RecordRef
	calls []string
}

func (r *recordingTools) Specs() []application.ToolSpec {
	return []application.ToolSpec{{Name: "search_records"}}
}

func (r *recordingTools) Run(_ context.Context, name string, _ json.RawMessage) (application.ToolOutput, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.calls = append(r.calls, name)
	return application.ToolOutput{OK: true, Records: r.refs}, nil
}

func toolStep(name, input string) application.Step {
	return application.Step{Calls: []application.ToolCall{{ID: "c-" + name, Name: name, Input: json.RawMessage(input)}}}
}

func TestAskStreamSendsAStepPerToolCallThenTheAnswerThenDone(t *testing.T) {
	t.Parallel()
	refs := []domain.RecordRef{{Slug: "conflictos", ID: "C-1", Title: "Bloqueo de vía"}}
	model := &stepModel{steps: []application.Step{
		toolStep("search_records", `{"query":"Comunidad Norte"}`),
		toolStep("get_timeline", `{"module":"conflictos","id":"C-1"}`),
		{Text: "El bloqueo sigue [1]."},
	}}
	res, events := askStream(t, analysthttp.Options{Ask: analystFor(model, &recordingTools{refs: refs}, nil)}, `{"question":"¿Qué pasa en el norte?"}`)
	if res.Code != http.StatusOK || !strings.HasPrefix(res.Header().Get("Content-Type"), "text/event-stream") ||
		res.Header().Get("Cache-Control") != "no-cache" {
		t.Fatalf("status = %d, headers = %v", res.Code, res.Header())
	}
	want := []sseEvent{
		{"step", `{"label":"Buscando registros…"}`},
		{"step", `{"label":"Leyendo la línea de tiempo…"}`},
		{"answer", `{"answer":"El bloqueo sigue [1].","sources":[{"n":1,"module":"conflictos","id":"C-1","title":"Bloqueo de vía"}],"blocks":[]}`},
		{"done", `{}`},
	}
	if !slices.Equal(events, want) {
		t.Fatalf("events = %q\nwant     %q", events, want)
	}
}

func TestAskStreamStepsNeverCarryToolInputsOrResults(t *testing.T) {
	t.Parallel()
	refs := []domain.RecordRef{{Slug: "actores", ID: "A-77", Title: "Comunidad Sintética"}}
	model := &stepModel{steps: []application.Step{
		toolStep("search_records", `{"query":"Persona Sintética 12345678"}`),
		toolStep("get_record", `{"module":"actores","id":"A-77"}`),
		{Text: "La comunidad dialoga [1]."},
	}}
	_, events := askStream(t, analysthttp.Options{Ask: analystFor(model, &recordingTools{refs: refs}, nil)}, `{"question":"¿Quién dialoga?"}`)
	steps := 0
	for _, e := range events {
		if e.name != "step" {
			continue
		}
		steps++
		var body map[string]any
		if err := json.Unmarshal([]byte(e.data), &body); err != nil || len(body) != 1 {
			t.Fatalf("step %q: want exactly one field, the label", e.data)
		}
		for _, private := range []string{"Persona", "12345678", "A-77", "actores", "Comunidad", "query"} {
			if strings.Contains(e.data, private) {
				t.Fatalf("step %q carries %q", e.data, private)
			}
		}
	}
	if steps != 2 {
		t.Fatalf("steps = %d, want 2 in %q", steps, events)
	}
}

func TestAskStreamAnswerIsExactlyTheBodyOfAsk(t *testing.T) {
	t.Parallel()
	refs := []domain.RecordRef{{Slug: "conflictos", ID: "C-1", Title: "Bloqueo <de> vía"}}
	script := func() *stepModel {
		return &stepModel{steps: []application.Step{
			toolStep("search_records", `{}`),
			{Text: "El bloqueo sigue [1].\nSegunda línea.\n```bloques\n[" +
				`{"tipo":"registro","fuente":1},{"tipo":"alerta","fuente":1,"texto":"<b>Paro</b> anunciado"},` +
				`{"tipo":"cronologia","fuente":1,"eventos":[{"fecha":"2026-03-02","texto":"Inicio"}]}]` + "\n```"},
		}}
	}
	question := `{"question":"¿Qué pasa?"}`
	plain := ask(t, analysthttp.Options{Ask: analystFor(script(), &recordingTools{refs: refs}, nil)}, question)
	_, events := askStream(t, analysthttp.Options{Ask: analystFor(script(), &recordingTools{refs: refs}, nil)}, question)
	if plain.Code != http.StatusOK || len(events) != 3 || events[1].name != "answer" {
		t.Fatalf("ask status = %d, events = %q", plain.Code, events)
	}
	if want := strings.TrimSpace(plain.Body.String()); events[1].data != want {
		t.Fatalf("answer event = %s\nask body     = %s", events[1].data, want)
	}
}

// blockingModel waits for its context, as a model past the time budget does.
type blockingModel struct{}

func (blockingModel) Next(ctx context.Context, _ []application.ToolSpec, _ []application.Turn) (application.Step, error) {
	<-ctx.Done()
	return application.Step{}, ctx.Err()
}

type failingModel struct{ err error }

func (f failingModel) Next(context.Context, []application.ToolSpec, []application.Turn) (application.Step, error) {
	return application.Step{}, f.err
}

func analystWith(model application.ToolModel, timeout time.Duration) func(context.Context, string) (*application.Ask, error) {
	return func(context.Context, string) (*application.Ask, error) {
		return &application.Ask{Model: model, Tools: &recordingTools{}, Timeout: timeout, Seal: func(_ context.Context, q string) (privacy.Sanitised[string], error) {
			return privacy.ExemptPayload(q, privacy.ExemptConstant), nil
		}}, nil
	}
}

func TestAskStreamSendsEachFailureOfAskAsOneErrorEvent(t *testing.T) {
	t.Parallel()
	loop := make([]application.Step, 10)
	for i := range loop {
		loop[i] = toolStep("search_records", `{}`)
	}
	cases := []struct {
		name   string
		status int
		body   string
		opts   func() analysthttp.Options
	}{
		{"invalid question", http.StatusUnprocessableEntity, `{"question":"  "}`, func() analysthttp.Options {
			return analysthttp.Options{Ask: analystFor(&stepModel{}, &recordingTools{}, nil)}
		}},
		{"external AI off", http.StatusConflict, "", func() analysthttp.Options {
			return analysthttp.Options{Ask: func(context.Context, string) (*application.Ask, error) { return nil, privacy.ErrDisabled }}
		}},
		{"no analyst configured", http.StatusServiceUnavailable, "", func() analysthttp.Options { return analysthttp.Options{} }},
		{"provider down", http.StatusServiceUnavailable, "", func() analysthttp.Options {
			return analysthttp.Options{Ask: analystWith(failingModel{fmt.Errorf("bridge: %w", application.ErrModelUnavailable)}, 0)}
		}},
		{"bad citations", http.StatusBadGateway, "", func() analysthttp.Options {
			return analysthttp.Options{Ask: analystFor(&stepModel{steps: []application.Step{{Text: "Hubo heridos [3]."}}}, &recordingTools{}, nil)}
		}},
		{"too many tool calls", http.StatusBadGateway, "", func() analysthttp.Options {
			return analysthttp.Options{Ask: analystFor(&stepModel{steps: slices.Clone(loop)}, &recordingTools{}, nil)}
		}},
		{"model failed", http.StatusBadGateway, "", func() analysthttp.Options {
			return analysthttp.Options{Ask: analystWith(failingModel{errors.New("narrator: the answer was truncated")}, 0)}
		}},
		{"too slow", http.StatusGatewayTimeout, "", func() analysthttp.Options {
			return analysthttp.Options{Ask: analystWith(blockingModel{}, 20*time.Millisecond)}
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			body := tc.body
			if body == "" {
				body = `{"question":"¿Algo?"}`
			}
			plain := ask(t, tc.opts(), body)
			var detail struct {
				Detail string `json:"detail"`
			}
			if err := json.Unmarshal(plain.Body.Bytes(), &detail); err != nil || plain.Code != tc.status {
				t.Fatalf("ask: status = %d, body = %s, want %d", plain.Code, plain.Body, tc.status)
			}
			res, events := askStream(t, tc.opts(), body)
			wantError, _ := json.Marshal(struct {
				Status int    `json:"status"`
				Detail string `json:"detail"`
			}{tc.status, detail.Detail})
			var errorsSeen []sseEvent
			for _, e := range events {
				if e.name == "error" {
					errorsSeen = append(errorsSeen, e)
				}
			}
			if res.Code != http.StatusOK || len(errorsSeen) != 1 || errorsSeen[0].data != string(wantError) ||
				events[len(events)-1] != (sseEvent{"done", "{}"}) || events[len(events)-2].name != "error" {
				t.Fatalf("events = %q, want one error %s then done", events, wantError)
			}
			for _, e := range events {
				if e.name == "answer" {
					t.Fatalf("a failed question sent an answer: %q", events)
				}
			}
		})
	}
}

// gatedModel asks for one tool, then waits until the test lets it answer.
type gatedModel struct {
	release chan struct{}
	calls   int
}

func (g *gatedModel) Next(ctx context.Context, _ []application.ToolSpec, _ []application.Turn) (application.Step, error) {
	g.calls++
	if g.calls == 1 {
		return toolStep("search_records", `{}`), nil
	}
	select {
	case <-g.release:
		return application.Step{Text: "No encontré registros."}, nil
	case <-ctx.Done():
		return application.Step{}, ctx.Err()
	}
}

func TestAskStreamFlushesEachStepAndKeepsTheConnectionAliveWhileTheModelWorks(t *testing.T) {
	t.Parallel()
	model := &gatedModel{release: make(chan struct{})}
	mux := http.NewServeMux()
	analysthttp.Routes(mux, analysthttp.Options{Ask: analystFor(model, &recordingTools{}, nil), Heartbeat: 10 * time.Millisecond})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mux.ServeHTTP(w, r.WithContext(scoped(r.Context())))
	}))
	t.Cleanup(srv.Close)
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, srv.URL+streamPath, strings.NewReader(`{"question":"¿Algo?"}`))
	res, err := srv.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = res.Body.Close() }()
	lines := bufio.NewScanner(res.Body)
	// The step arrives while the model still holds the answer back: it was flushed, not buffered.
	waitFor := func(want string) {
		t.Helper()
		for lines.Scan() {
			if lines.Text() == want {
				return
			}
		}
		t.Fatalf("the stream ended before %q: %v", want, lines.Err())
	}
	waitFor(`data: {"label":"Buscando registros…"}`)
	waitFor(": ping")
	close(model.release)
	waitFor("event: answer")
	waitFor("event: done")
}

// cancellingTools cancels the request from inside a tool, as a client that goes away mid-loop does.
type cancellingTools struct {
	cancel context.CancelFunc
	calls  int
}

func (c *cancellingTools) Specs() []application.ToolSpec { return nil }

func (c *cancellingTools) Run(context.Context, string, json.RawMessage) (application.ToolOutput, error) {
	c.calls++
	c.cancel()
	return application.ToolOutput{OK: true}, nil
}

// countingModel asks for a tool on every call and ignores its context, as a slow adapter might.
type countingModel struct{ calls int }

func (c *countingModel) Next(context.Context, []application.ToolSpec, []application.Turn) (application.Step, error) {
	c.calls++
	return toolStep("search_records", `{}`), nil
}

func TestACancelledRequestStopsTheLoopOnBothRoutes(t *testing.T) {
	t.Parallel()
	for _, path := range []string{"/system/analyst/ask", streamPath} {
		t.Run(path, func(t *testing.T) {
			t.Parallel()
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			model, tools := &countingModel{}, &cancellingTools{cancel: cancel}
			var logs bytes.Buffer
			opts := analysthttp.Options{
				Ask: analystFor(model, tools, nil), Logger: slog.New(slog.NewTextHandler(&logs, nil)),
			}
			mux := http.NewServeMux()
			analysthttp.Routes(mux, opts)
			res := httptest.NewRecorder()
			mux.ServeHTTP(res, httptest.NewRequestWithContext(scoped(ctx), http.MethodPost, path, strings.NewReader(`{"question":"¿Algo?"}`)))
			if model.calls != 1 || tools.calls != 1 {
				t.Fatalf("model calls = %d, tool calls = %d: the loop went on after the cancel", model.calls, tools.calls)
			}
			if path == streamPath {
				events := parseEvents(t, res.Body.String())
				if !slices.Equal(events, []sseEvent{{"step", `{"label":"Buscando registros…"}`}}) {
					t.Fatalf("events = %q: nothing may follow a cancel", events)
				}
				if !strings.Contains(logs.String(), "status=499") {
					t.Fatalf("log = %q, want the closed stream as 499", logs.String())
				}
				return
			}
			if res.Code != analysthttp.StatusClientClosed {
				t.Fatalf("status = %d, want %d", res.Code, analysthttp.StatusClientClosed)
			}
		})
	}
}

// A panic while answering is an error event like /ask's 500, never a crash of the API process
// (the stream answers from its own goroutine, out of reach of httpx.Recover).
func TestAPanicWhileAnsweringOnTheStreamIsAnErrorEventNotACrash(t *testing.T) {
	t.Parallel()
	opts := analysthttp.Options{Ask: func(context.Context, string) (*application.Ask, error) {
		panic("synthetic analyst panic")
	}}
	_, events := askStream(t, opts, `{"question":"¿Algo?"}`)
	want := []sseEvent{
		{"error", `{"status":500,"detail":"Internal Server Error"}`},
		{"done", `{}`},
	}
	if !slices.Equal(events, want) {
		t.Fatalf("events = %q\nwant     %q", events, want)
	}
}
