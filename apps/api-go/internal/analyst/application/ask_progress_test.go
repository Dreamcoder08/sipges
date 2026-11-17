//nolint:misspell // Spanish record modules and labels in synthetic fixtures.
package application_test

import (
	"context"
	"encoding/json"
	"errors"
	"slices"
	"strings"
	"testing"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/analyst/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/analyst/domain"
)

// The live progress of a question (odd/tasks/chat-first-ui.md T10): one fixed Spanish label per
// tool call, never the call's input or what the tool returned.

// labels collects the steps a loop reports.
type labels struct{ seen []string }

func (l *labels) ToolStep(label string) { l.seen = append(l.seen, label) }

func callWith(name, input string) application.ToolCall {
	return application.ToolCall{ID: "c-" + name, Name: name, Input: json.RawMessage(input)}
}

func TestAskReportsOneFixedStepPerToolCallInOrder(t *testing.T) {
	t.Parallel()
	refs := []domain.RecordRef{{Slug: "conflictos", ID: "C-1", Title: "Bloqueo de vía"}}
	tools := &fakeTools{answers: map[string][]domain.RecordRef{"search_records": refs, "get_record": refs, "get_links": nil}}
	model := &scriptedModel{steps: []application.Step{
		{Calls: []application.ToolCall{callWith("search_records", `{"query":"Comunidad Norte"}`)}},
		{Calls: []application.ToolCall{callWith("get_record", `{"id":"C-1"}`), callWith("get_links", `{"id":"C-1"}`)}},
		{Text: "El bloqueo sigue [1]."},
	}}
	progress := &labels{}
	answer, err := application.Ask{Model: model, Tools: tools, Seal: sealed}.AnswerWithProgress(t.Context(), "¿Qué pasa?", progress)
	if err != nil || answer.Text != "El bloqueo sigue [1]." {
		t.Fatalf("answer = %+v, err = %v", answer, err)
	}
	want := []string{"Buscando registros…", "Leyendo el registro…", "Revisando vínculos…"}
	if !slices.Equal(progress.seen, want) {
		t.Fatalf("steps = %q, want %q", progress.seen, want)
	}
	for _, label := range progress.seen {
		if strings.Contains(label, "Comunidad") || strings.Contains(label, "C-1") || strings.Contains(label, "Bloqueo") {
			t.Fatalf("step %q carries a tool input or result", label)
		}
	}
}

func TestEveryReadToolHasItsFixedSpanishLabel(t *testing.T) {
	t.Parallel()
	for tool, want := range map[string]string{
		"search_records":    "Buscando registros…",
		"get_record":        "Leyendo el registro…",
		"get_links":         "Revisando vínculos…",
		"get_timeline":      "Leyendo la línea de tiempo…",
		"get_briefing":      "Leyendo el resumen del proyecto…",
		"list_object_types": "Revisando los tipos de registro…",
		// A name the model made up is never echoed: it is model output, not a known tool.
		"drop_table <script>": "Consultando una herramienta…",
	} {
		t.Run(tool, func(t *testing.T) {
			t.Parallel()
			model := &scriptedModel{steps: []application.Step{
				{Calls: []application.ToolCall{callWith(tool, `{}`)}},
				{Text: "No encontré registros."},
			}}
			progress := &labels{}
			_, err := application.Ask{Model: model, Tools: &fakeTools{}, Seal: sealed}.AnswerWithProgress(t.Context(), "¿Algo?", progress)
			if err != nil || !slices.Equal(progress.seen, []string{want}) {
				t.Fatalf("steps = %q, err = %v, want [%q]", progress.seen, err, want)
			}
		})
	}
}

func TestAskReportsNoStepForACallPastTheLimit(t *testing.T) {
	t.Parallel()
	tools := &fakeTools{answers: map[string][]domain.RecordRef{"search_records": nil}}
	steps := make([]application.Step, 10)
	for i := range steps {
		steps[i] = call("search_records")
	}
	progress := &labels{}
	_, err := application.Ask{Model: &scriptedModel{steps: steps}, Tools: tools, Seal: sealed}.AnswerWithProgress(t.Context(), "¿Algo?", progress)
	if !errors.Is(err, application.ErrTooManyToolCalls) || len(progress.seen) != application.MaxToolCalls {
		t.Fatalf("err = %v, steps = %d, want %d", err, len(progress.seen), application.MaxToolCalls)
	}
}

// cancellingTools cancels the question's context from inside a tool, as a client that goes away
// mid-loop does, and counts every call that still reaches it.
type cancellingTools struct {
	cancel context.CancelFunc
	calls  []string
}

func (c *cancellingTools) Specs() []application.ToolSpec { return nil }

func (c *cancellingTools) Run(_ context.Context, name string, _ json.RawMessage) (application.ToolOutput, error) {
	c.calls = append(c.calls, name)
	c.cancel()
	return application.ToolOutput{OK: true}, nil
}

func TestAskStopsCallingTheModelAndToolsOnceItsContextIsCancelled(t *testing.T) {
	t.Parallel()
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	tools := &cancellingTools{cancel: cancel}
	// The model ignores its context, as a slow adapter might: the loop itself must stop.
	model := &scriptedModel{steps: []application.Step{
		{Calls: []application.ToolCall{callWith("search_records", `{}`), callWith("get_record", `{}`)}},
		call("get_links"),
		{Text: "No encontré registros."},
	}}
	progress := &labels{}
	_, err := application.Ask{Model: model, Tools: tools, Seal: sealed}.AnswerWithProgress(ctx, "¿Algo?", progress)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v, want context.Canceled", err)
	}
	if len(model.seen) != 1 || !slices.Equal(tools.calls, []string{"search_records"}) {
		t.Fatalf("model calls = %d, tool calls = %q: the loop went on after the cancel", len(model.seen), tools.calls)
	}
	if !slices.Equal(progress.seen, []string{"Buscando registros…"}) {
		t.Fatalf("steps = %q", progress.seen)
	}
}

func TestAskWithoutProgressStopsOnceItsContextIsCancelled(t *testing.T) {
	t.Parallel()
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	tools := &cancellingTools{cancel: cancel}
	model := &scriptedModel{steps: []application.Step{call("search_records"), call("get_links"), {Text: "No encontré registros."}}}
	_, err := application.Ask{Model: model, Tools: tools, Seal: sealed}.Answer(ctx, "¿Algo?")
	if !errors.Is(err, context.Canceled) || len(model.seen) != 1 || len(tools.calls) != 1 {
		t.Fatalf("err = %v, model calls = %d, tool calls = %d", err, len(model.seen), len(tools.calls))
	}
}
