//nolint:misspell // Spanish record modules and messages in synthetic fixtures.
package application_test

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/analyst/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/analyst/domain"
)

// scriptedModel answers each Next with the next step of its script and records what it was shown.
type scriptedModel struct {
	steps []application.Step
	seen  [][]application.Turn
	block bool
}

func (m *scriptedModel) Next(ctx context.Context, _ []application.ToolSpec, turns []application.Turn) (application.Step, error) {
	m.seen = append(m.seen, turns)
	if m.block {
		<-ctx.Done()
		return application.Step{}, ctx.Err()
	}
	if len(m.steps) == 0 {
		return application.Step{}, errors.New("script exhausted")
	}
	step := m.steps[0]
	m.steps = m.steps[1:]
	return step, nil
}

// fakeTools answers every call with the records of its name.
type fakeTools struct {
	answers map[string][]domain.RecordRef
	calls   []string
}

func (f *fakeTools) Specs() []application.ToolSpec {
	return []application.ToolSpec{{Name: "search_records", Description: "Busca registros"}}
}

func (f *fakeTools) Run(_ context.Context, name string, _ json.RawMessage) (application.ToolOutput, error) {
	f.calls = append(f.calls, name)
	refs, ok := f.answers[name]
	if !ok {
		return application.ToolOutput{Refusal: "Herramienta desconocida: " + name}, nil
	}
	return application.ToolOutput{OK: true, Records: refs}, nil
}

func call(name string) application.Step {
	return application.Step{Calls: []application.ToolCall{{ID: "c-" + name, Name: name, Input: json.RawMessage(`{}`)}}}
}

func TestAskAnswersWithTheRecordsTheToolsReturned(t *testing.T) {
	t.Parallel()
	tools := &fakeTools{answers: map[string][]domain.RecordRef{
		"search_records": {{Slug: "conflictos", ID: "C-1", Title: "Bloqueo de vía"}, {Slug: "actores", ID: "A-7", Title: "Comunidad Norte"}},
	}}
	model := &scriptedModel{steps: []application.Step{
		call("search_records"),
		{Text: "La comunidad mantiene el bloqueo [1][2]."},
	}}
	answer, err := application.Ask{Model: model, Tools: tools}.Answer(t.Context(), "¿Qué pasa en el norte?")
	if err != nil {
		t.Fatal(err)
	}
	if answer.Text != "La comunidad mantiene el bloqueo [1][2]." || len(answer.Sources) != 2 {
		t.Fatalf("answer = %+v", answer)
	}
	// The second turn shows the model the numbered records of the tool result.
	last := model.seen[1]
	result := last[len(last)-1]
	if result.Result == nil || len(result.Result.Sources) != 2 || result.Result.Sources[1].N != 2 {
		t.Fatalf("tool turn = %+v", result)
	}
	if first := model.seen[0]; len(first) != 1 || first[0].Question != "¿Qué pasa en el norte?" {
		t.Fatalf("first turns = %+v", first)
	}
}

func TestAskRefusesAnAnswerCitingARecordNoToolReturned(t *testing.T) {
	t.Parallel()
	tools := &fakeTools{answers: map[string][]domain.RecordRef{"search_records": {{Slug: "conflictos", ID: "C-1"}}}}
	model := &scriptedModel{steps: []application.Step{call("search_records"), {Text: "Hubo heridos [4]."}}}
	_, err := application.Ask{Model: model, Tools: tools}.Answer(t.Context(), "¿Heridos?")
	if !errors.Is(err, domain.ErrUnresolvedCitation) {
		t.Fatalf("err = %v, want ErrUnresolvedCitation", err)
	}
}

func TestAskStopsAfterSixToolCalls(t *testing.T) {
	t.Parallel()
	tools := &fakeTools{answers: map[string][]domain.RecordRef{"search_records": nil}}
	steps := make([]application.Step, 10)
	for i := range steps {
		steps[i] = call("search_records")
	}
	model := &scriptedModel{steps: steps}
	_, err := application.Ask{Model: model, Tools: tools}.Answer(t.Context(), "¿Algo?")
	if !errors.Is(err, application.ErrTooManyToolCalls) {
		t.Fatalf("err = %v, want ErrTooManyToolCalls", err)
	}
	if len(tools.calls) != application.MaxToolCalls || application.MaxToolCalls != 6 {
		t.Fatalf("tool calls = %d (max %d), want 6", len(tools.calls), application.MaxToolCalls)
	}
}

func TestAskGivesUpWhenItsTimeRunsOut(t *testing.T) {
	t.Parallel()
	model := &scriptedModel{block: true}
	start := time.Now()
	_, err := application.Ask{Model: model, Tools: &fakeTools{}, Timeout: 20 * time.Millisecond}.Answer(t.Context(), "¿Algo?")
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("err = %v, want DeadlineExceeded", err)
	}
	if time.Since(start) > 5*time.Second {
		t.Fatal("the timeout did not stop the model")
	}
	if application.AskTimeout != 30*time.Second {
		t.Fatalf("default timeout = %v, want 30s", application.AskTimeout)
	}
}

func TestAskPassesARefusalBackToTheModel(t *testing.T) {
	t.Parallel()
	tools := &fakeTools{answers: map[string][]domain.RecordRef{}}
	model := &scriptedModel{steps: []application.Step{call("drop_table"), {Text: "No encontré registros."}}}
	answer, err := application.Ask{Model: model, Tools: tools}.Answer(t.Context(), "¿Algo?")
	if err != nil || len(answer.Sources) != 0 {
		t.Fatalf("answer = %+v, err = %v", answer, err)
	}
	last := model.seen[1]
	if r := last[len(last)-1].Result; r == nil || r.Output.Refusal != "Herramienta desconocida: drop_table" {
		t.Fatalf("tool turn = %+v", last[len(last)-1])
	}
}
