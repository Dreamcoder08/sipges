package http_test

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"sync"
	"testing"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/analyst/application"
	analysthttp "github.com/Dreamcoder08/sipges/apps/api-go/internal/analyst/http"
	privacy "github.com/Dreamcoder08/sipges/apps/api-go/internal/privacy/application"
)

// exempt stands in for the egress guard in these tests: every text passes unchanged.
func exempt(_ context.Context, texts []string) ([]privacy.Sanitised[string], error) {
	out := make([]privacy.Sanitised[string], 0, len(texts))
	for _, text := range texts {
		out = append(out, privacy.ExemptPayload(text, privacy.ExemptConstant))
	}
	return out, nil
}

// earlierModel answers at once and keeps the earlier turns it was shown, "question|answer".
type earlierModel struct {
	mu   sync.Mutex
	seen []string
	asks int
}

func (m *earlierModel) Next(_ context.Context, _ []application.ToolSpec, turns []application.Turn) (application.Step, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.asks++
	for _, turn := range turns {
		if turn.Earlier != nil {
			m.seen = append(m.seen, turn.Earlier.Question.Value()+"|"+turn.Earlier.Answer.Value())
		}
	}
	return application.Step{Text: "Sin registros nuevos."}, nil
}

func earlierAnalyst(model application.ToolModel) analysthttp.Options {
	return analysthttp.Options{Ask: func(context.Context, string) (*application.Ask, error) {
		return &application.Ask{Model: model, Tools: oneTool{}, Seal: exempt}, nil
	}}
}

func historyBody(t *testing.T, history any) string {
	t.Helper()
	raw, err := json.Marshal(map[string]any{"question": "¿Y desde cuándo?", "history": history})
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}

var twoEarlier = []map[string]string{
	{"question": "¿Qué pasa en el norte?", "answer": "El bloqueo sigue [1]."},
	{"question": "¿Quién lo convoca?", "answer": "La comunidad [2]."},
}

// odd/tasks/chat-first-ui.md T9: both routes take the earlier turns and hand them to the loop.
func TestAskAndAskStreamPassTheHistoryToTheModel(t *testing.T) {
	t.Parallel()
	want := "¿Qué pasa en el norte?|El bloqueo sigue.,¿Quién lo convoca?|La comunidad."
	model := &earlierModel{}
	if res := ask(t, earlierAnalyst(model), historyBody(t, twoEarlier)); res.Code != http.StatusOK {
		t.Fatalf("ask: status = %d, body = %s", res.Code, res.Body)
	}
	if got := strings.Join(model.seen, ","); got != want {
		t.Fatalf("ask: earlier turns = %q, want %q", got, want)
	}
	streamed := &earlierModel{}
	_, events := askStream(t, earlierAnalyst(streamed), historyBody(t, twoEarlier))
	if len(events) == 0 || events[len(events)-1].name != "done" {
		t.Fatalf("stream events = %+v", events)
	}
	if got := strings.Join(streamed.seen, ","); got != want {
		t.Fatalf("stream: earlier turns = %q, want %q", got, want)
	}
}

func TestAskRefusesAHistoryBeyondItsLimitsWithA422(t *testing.T) {
	t.Parallel()
	seven := make([]map[string]string, application.MaxHistoryTurns+1)
	for i := range seven {
		seven[i] = map[string]string{"question": "¿Algo?", "answer": "Nada."}
	}
	cases := map[string]any{
		"seven turns":         seven,
		"8,001 characters":    []map[string]string{{"question": "¿", "answer": strings.Repeat("ñ", application.MaxHistoryChars)}},
		"no answer":           []map[string]string{{"question": "¿Algo?"}},
		"only citations":      []map[string]string{{"question": "¿Algo?", "answer": "[1][2]"}},
		"a null turn":         []any{nil},
		"an object":           map[string]string{"question": "¿Algo?"},
		"not a list":          "¿Algo?",
		"a turn not a object": []string{"¿Algo?"},
	}
	for name, history := range cases {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			model := &earlierModel{}
			res := ask(t, earlierAnalyst(model), historyBody(t, history))
			if res.Code != http.StatusUnprocessableEntity || !strings.Contains(res.Body.String(), "El historial admite") {
				t.Fatalf("status = %d, body = %s", res.Code, res.Body)
			}
			if model.asks != 0 {
				t.Fatalf("the model was asked %d times", model.asks)
			}
		})
	}
}

// A history at its limits is accepted, though its body passes the old 16 KiB read limit.
func TestAskAcceptsAFullHistoryLargerThanTheOldBodyLimit(t *testing.T) {
	t.Parallel()
	history := make([]map[string]string, application.MaxHistoryTurns)
	per := application.MaxHistoryChars / application.MaxHistoryTurns
	for i := range history {
		// Each X becomes the six-byte JSON escape of a ñ, so the body is about 48 KiB.
		history[i] = map[string]string{"question": "¿", "answer": strings.Repeat("X", per-1)}
	}
	body := strings.ReplaceAll(historyBody(t, history), "X", `\u00f1`)
	if len(body) <= 16<<10 {
		t.Fatalf("body is %d bytes, want more than 16 KiB", len(body))
	}
	if res := ask(t, earlierAnalyst(&earlierModel{}), body); res.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", res.Code, res.Body)
	}
}

// The stream refuses a history beyond its limits as /ask does: one error event with 422, before
// any model call or release.
func TestAskStreamRefusesAHistoryBeyondItsLimitsWithA422Event(t *testing.T) {
	t.Parallel()
	seven := make([]map[string]string, application.MaxHistoryTurns+1)
	for i := range seven {
		seven[i] = map[string]string{"question": "¿Algo?", "answer": "Nada."}
	}
	model := &earlierModel{}
	_, events := askStream(t, earlierAnalyst(model), historyBody(t, seven))
	var failure *sseEvent
	for i := range events {
		if events[i].name == "error" {
			failure = &events[i]
		}
	}
	if failure == nil {
		t.Fatalf("no error event in %+v", events)
	}
	var data struct {
		Status int    `json:"status"`
		Detail string `json:"detail"`
	}
	if err := json.Unmarshal([]byte(failure.data), &data); err != nil {
		t.Fatal(err)
	}
	if data.Status != http.StatusUnprocessableEntity || !strings.Contains(data.Detail, "El historial admite") {
		t.Fatalf("error event = %+v", data)
	}
	if model.asks != 0 {
		t.Fatalf("the model was asked %d times", model.asks)
	}
}

// The worst case the limits allow fits the body: 500 + 8,000 characters outside the BMP, each
// written as a JSON surrogate pair (😀, twelve bytes).
func TestAskAcceptsAFullHistoryOfAstralCharactersWrittenAsEscapes(t *testing.T) {
	t.Parallel()
	history := make([]map[string]string, application.MaxHistoryTurns)
	per := application.MaxHistoryChars / application.MaxHistoryTurns
	for i := range history {
		history[i] = map[string]string{"question": "X", "answer": strings.Repeat("X", per-1)}
	}
	raw, err := json.Marshal(map[string]any{"question": strings.Repeat("X", 500), "history": history})
	if err != nil {
		t.Fatal(err)
	}
	// Built in parts so the file holds the escape, not the character: \ud83d\ude00.
	surrogates := `\` + "ud83d" + `\` + "ude00"
	body := strings.ReplaceAll(string(raw), "X", surrogates)
	if len(body) <= 64<<10 {
		t.Fatalf("body is %d bytes, want more than 64 KiB", len(body))
	}
	if res := ask(t, earlierAnalyst(&earlierModel{}), body); res.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", res.Code, res.Body)
	}
}
