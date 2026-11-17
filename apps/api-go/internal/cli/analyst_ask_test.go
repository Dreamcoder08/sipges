//nolint:misspell // Spanish labels and messages in synthetic fixtures.
package cli

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// sipgesctl analyst ask --steps (odd/tasks/chat-first-ui.md T10): the steps on stderr as they
// arrive, the answer on stdout as without --steps.

const (
	syntheticAnswer = `{"answer":"El bloqueo sigue [1].","sources":[{"n":1,"module":"conflictos","id":"C-1","title":"Bloqueo de vía"}],"blocks":[]}`
	syntheticAsk    = `{"question":"¿Qué pasa en el norte?"}`
)

// noticingWriter is a stderr that says when its first line arrived.
type noticingWriter struct {
	mu    sync.Mutex
	buf   bytes.Buffer
	first chan struct{}
	once  sync.Once
}

func (n *noticingWriter) Write(p []byte) (int, error) {
	n.mu.Lock()
	defer n.mu.Unlock()
	written, err := n.buf.Write(p)
	if bytes.Contains(n.buf.Bytes(), []byte("\n")) {
		n.once.Do(func() { close(n.first) })
	}
	return written, err
}

func (n *noticingWriter) String() string {
	n.mu.Lock()
	defer n.mu.Unlock()
	return n.buf.String()
}

func streamEvents(w http.ResponseWriter, frames ...string) {
	w.Header().Set("Content-Type", "text/event-stream")
	w.WriteHeader(http.StatusOK)
	for _, frame := range frames {
		_, _ = io.WriteString(w, frame)
		w.(http.Flusher).Flush()
	}
}

func TestAnalystAskStepsPrintsEachStepOnStderrAsItArrives(t *testing.T) {
	stderr := &noticingWriter{first: make(chan struct{})}
	var path, accept, body string
	h := newHarness(t, func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		path, accept, body = r.Method+" "+r.URL.Path, r.Header.Get("Accept"), string(raw)
		streamEvents(w, "event: step\ndata: {\"label\":\"Buscando registros…\"}\n\n")
		// The answer waits until the first step reached the terminal: it was printed as it came.
		select {
		case <-stderr.first:
		case <-time.After(5 * time.Second):
			t.Error("the first step was not printed before the answer")
		}
		streamEvents(w, ": ping\n\n", "event: step\ndata: {\"label\":\"Leyendo el registro…\"}\n\n",
			"event: answer\ndata: "+syntheticAnswer+"\n\n", "event: done\ndata: {}\n\n")
	})
	var stdout bytes.Buffer
	code := Run(context.Background(), []string{"analyst", "ask", "--body", "-", "--steps"}, IO{
		Stdin: strings.NewReader(syntheticAsk), Stdout: &stdout, Stderr: stderr,
		Env: func(name string) string { return h.env[name] },
	})
	if code != ExitOK || stderr.String() != "Buscando registros…\nLeyendo el registro…\n" {
		t.Fatalf("exit %d, stderr %q", code, stderr.String())
	}
	if path != "POST /system/analyst/ask/stream" || accept != "text/event-stream" || body != syntheticAsk {
		t.Fatalf("request %s, accept %q, body %q", path, accept, body)
	}
	// The answer reads exactly as the answer of /ask without --steps.
	plain := newHarness(t, func(w http.ResponseWriter, _ *http.Request) { jsonAnswer(w, http.StatusOK, syntheticAnswer) })
	want := plain.run(syntheticAsk, "analyst", "ask", "--body", "-")
	if stdout.String() != want.stdout || want.code != ExitOK {
		t.Fatalf("stdout %q\nwant   %q", stdout.String(), want.stdout)
	}
}

func TestAnalystAskWithoutStepsStillAsksTheJSONRoute(t *testing.T) {
	var path string
	h := newHarness(t, func(w http.ResponseWriter, r *http.Request) {
		path = r.Method + " " + r.URL.Path
		jsonAnswer(w, http.StatusOK, syntheticAnswer)
	})
	got := h.run(syntheticAsk, "analyst", "ask", "--body", "-", "--json")
	body := decode(t, got.stdout)
	data, _ := body["data"].(map[string]any)
	if got.code != ExitOK || got.stderr != "" || path != "POST /system/analyst/ask" || body["route"] != "POST /system/analyst/ask" ||
		data["answer"] != "El bloqueo sigue [1]." {
		t.Fatalf("%+v, path %s", got, path)
	}
}

func TestAnalystAskStepsAnswersAnErrorEventAsAskAnswersItsStatus(t *testing.T) {
	for _, tc := range []struct {
		status int
		detail string
		exit   int
	}{
		{http.StatusConflict, "El envío a IA externa está desactivado para este proyecto", ExitRejected},
		{http.StatusUnprocessableEntity, "Escribe una pregunta de 1 a 500 caracteres", ExitRejected},
		{http.StatusBadGateway, "El analista no citó bien sus fuentes; vuelve a preguntar", ExitServer},
		{http.StatusServiceUnavailable, "El analista no está configurado en esta instalación", ExitServer},
		{http.StatusGatewayTimeout, "El analista tardó demasiado; vuelve a preguntar", ExitServer},
	} {
		streamed := newHarness(t, func(w http.ResponseWriter, _ *http.Request) {
			streamEvents(w, "event: step\ndata: {\"label\":\"Buscando registros…\"}\n\n",
				"event: error\ndata: {\"status\":"+strconv.Itoa(tc.status)+",\"detail\":\""+tc.detail+"\"}\n\n", "event: done\ndata: {}\n\n")
		})
		plain := newHarness(t, func(w http.ResponseWriter, _ *http.Request) {
			jsonAnswer(w, tc.status, `{"detail":"`+tc.detail+`"}`)
		})
		got := streamed.run(syntheticAsk, "analyst", "ask", "--body", "-", "--steps")
		want := plain.run(syntheticAsk, "analyst", "ask", "--body", "-")
		if got.code != tc.exit || want.code != tc.exit || got.stdout != "" ||
			got.stderr != "Buscando registros…\n"+want.stderr {
			t.Fatalf("%d: got %+v, want exit %d and %+v", tc.status, got, tc.exit, want)
		}
		asJSON := decode(t, streamed.run(syntheticAsk, "analyst", "ask", "--body", "-", "--steps", "--json").stdout)
		failure, _ := asJSON["error"].(map[string]any)
		if asJSON["ok"] != false || asJSON["status"] != float64(tc.status) || failure["detail"] != tc.detail {
			t.Fatalf("%d: --json %v", tc.status, asJSON)
		}
	}
}

func TestAnalystAskStepsSaysWhenTheStreamEndsWithoutAnAnswer(t *testing.T) {
	h := newHarness(t, func(w http.ResponseWriter, _ *http.Request) {
		streamEvents(w, "event: step\ndata: {\"label\":\"Buscando registros…\"}\n\n")
	})
	got := h.run(syntheticAsk, "analyst", "ask", "--body", "-", "--steps")
	if got.code != ExitNetwork || !strings.Contains(got.stderr, "the answer stream ended before its answer") {
		t.Fatalf("%+v", got)
	}
}

func TestAnalystAskStepsKeepsTheAPIsRefusalBeforeTheStream(t *testing.T) {
	h := newHarness(t, func(w http.ResponseWriter, _ *http.Request) {
		jsonAnswer(w, http.StatusForbidden, `{"detail":"Sin acceso a este proyecto"}`)
	})
	got := h.run(syntheticAsk, "analyst", "ask", "--body", "-", "--steps")
	if got.code != ExitForbidden || !strings.Contains(got.stderr, "Sin acceso a este proyecto") {
		t.Fatalf("%+v", got)
	}
}

func TestAnalystAskStepsRefusesAnOutputFile(t *testing.T) {
	h := newHarness(t, nil)
	got := h.run(syntheticAsk, "analyst", "ask", "--body", "-", "--steps", "--output", "answer.json")
	if got.code != ExitUsage || !strings.Contains(got.stderr, "--output") {
		t.Fatalf("%+v", got)
	}
}

func TestTheAskStreamIsInTheInventoryAndReachedByAnalystAskSteps(t *testing.T) {
	routes, err := Routes()
	if err != nil {
		t.Fatal(err)
	}
	stream, found := findRoute(routes, http.MethodPost, "/system/analyst/ask/stream")
	if !found || stream.Path != "/system/analyst/ask/stream" || stream.Access != AccessSession || !strings.Contains(stream.Summary, "analyst ask --steps") {
		t.Fatalf("stream route = %+v, found %v", stream, found)
	}
	h := newHarness(t, nil)
	if help := h.run("", "help").stdout; !strings.Contains(help, "analyst ask") || !strings.Contains(help, "--steps") {
		t.Fatalf("help does not name analyst ask --steps:\n%s", help)
	}
}
