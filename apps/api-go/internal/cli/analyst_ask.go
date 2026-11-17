package cli

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"unicode"
)

// analyst ask (odd/tasks/chat-first-ui.md T10): the Inicio question. Without --steps it is the
// typed command of POST /system/analyst/ask; with --steps it asks POST /system/analyst/ask/stream
// and prints each step's label on stderr as it arrives, then the answer as without --steps.

const (
	askPath       = "/system/analyst/ask"
	askStreamPath = "/system/analyst/ask/stream"
)

func (a *app) analystAsk(ctx context.Context, o *options, args []string) (int, error) {
	flags := o.addRequestFlags()
	steps := o.flags.Bool("steps", false, "print the analyst's steps on stderr as they happen")
	if err := o.parseNone(args); err != nil {
		return 0, err
	}
	path := askPath
	if *steps {
		path = askStreamPath
	}
	route, found := findRoute(a.routes, http.MethodPost, path)
	if !found {
		return 0, usageError("POST %s is not in the route inventory", path)
	}
	if !*steps {
		return o.send(ctx, route, route.Path, flags)
	}
	// An answer of events is read here, never saved or sent as a form.
	if err := o.refuse("output", "form", "field", "attach"); err != nil {
		return 0, err
	}
	out, err := o.prepare(route, route.Path, flags)
	if err != nil {
		return 0, err
	}
	out.accept = "text/event-stream"
	c, sessionFile, err := o.connect()
	if err != nil {
		return 0, err
	}
	ctx, cancel := o.timeoutContext(ctx)
	defer cancel()
	answer, err := c.events(ctx, out, func(label string) { _, _ = fmt.Fprintln(a.stderr, label) })
	if err != nil {
		return 0, err
	}
	if err := c.persist(sessionFile); err != nil {
		return 0, err
	}
	return o.answer(route.Method+" "+route.Path, answer), nil
}

// events sends a request answered with server-sent events: each step goes to step, and the answer
// or error event becomes the response, as the JSON route would have answered it. An answer that is
// not a stream (a refused session, role or project) is read as any other.
func (c *client) events(ctx context.Context, r request, step func(label string)) (*response, error) {
	answer, err := c.open(ctx, r)
	if err != nil {
		return nil, err
	}
	defer func() { _ = answer.Body.Close() }()
	if answer.StatusCode != http.StatusOK || !strings.HasPrefix(answer.Header.Get("Content-Type"), "text/event-stream") {
		return readAnswer(answer, "")
	}
	return readEvents(answer.Body, step)
}

// readEvents reads the ask stream until done: step, answer, error and done events, data on one or
// more lines, comments (heartbeats) skipped.
func readEvents(body io.Reader, step func(label string)) (*response, error) {
	lines := bufio.NewScanner(body)
	lines.Buffer(make([]byte, 0, 64<<10), maxAnswer)
	var name string
	var data []string
	var result *response
	for lines.Scan() {
		line := lines.Text()
		if line != "" {
			field, value, _ := strings.Cut(line, ":")
			value = strings.TrimPrefix(value, " ")
			switch field {
			case "event":
				name = value
			case "data":
				data = append(data, value)
			}
			continue
		}
		payload := []byte(strings.Join(data, "\n"))
		event := name
		name, data = "", nil
		switch event {
		case "step":
			var s struct {
				Label string `json:"label"`
			}
			if json.Unmarshal(payload, &s) == nil && s.Label != "" {
				step(printable(s.Label))
			}
		case "answer":
			var decoded any
			if err := json.Unmarshal(payload, &decoded); err != nil {
				return nil, &exitError{exit: ExitFailed, code: "bad_json", detail: "the API answered invalid JSON"}
			}
			result = &response{status: http.StatusOK, data: decoded}
		case "error":
			var failed struct {
				Status int    `json:"status"`
				Detail string `json:"detail"`
			}
			if err := json.Unmarshal(payload, &failed); err != nil || failed.Status == 0 {
				return nil, &exitError{exit: ExitFailed, code: "bad_json", detail: "the API answered invalid JSON"}
			}
			result = &response{status: failed.Status, data: map[string]any{"detail": failed.Detail}}
		case "done":
			if result != nil {
				return result, nil
			}
		}
	}
	if err := lines.Err(); err != nil {
		return nil, networkError(err)
	}
	return nil, &exitError{exit: ExitNetwork, code: "network", detail: "the answer stream ended before its answer"}
}

// printable drops control characters from a label before it reaches the terminal.
func printable(label string) string {
	return strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return -1
		}
		return r
	}, label)
}
