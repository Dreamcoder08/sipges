//nolint:misspell // Spanish record modules and messages in synthetic fixtures.
package application_test

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/analyst/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/analyst/domain"
	privacy "github.com/Dreamcoder08/sipges/apps/api-go/internal/privacy/application"
)

// countingSeal is sealed that also counts its releases and keeps the texts it was given.
type countingSeal struct {
	calls int
	texts []string
}

func (s *countingSeal) seal(ctx context.Context, texts []string) ([]privacy.Sanitised[string], error) {
	s.calls++
	s.texts = append(s.texts, texts...)
	return sealed(ctx, texts)
}

var earlier = []application.Exchange{
	{Question: "¿Qué pasa en el norte?", Answer: "La comunidad mantiene el bloqueo [1][2]."},
	{Question: "¿Desde cuándo?", Answer: "Desde marzo [1]."},
}

// odd/tasks/chat-first-ui.md T9: earlier turns reach the model before the question, sealed by the
// egress guard in the same release as the question, without their old citation numbers.
func TestAFollowUpShowsTheModelTheEarlierTurnsSealedWithTheQuestion(t *testing.T) {
	t.Parallel()
	tools := &fakeTools{answers: map[string][]domain.RecordRef{
		"search_records": {{Slug: "conflictos", ID: "C-1", Title: "Bloqueo de vía"}},
	}}
	model := &scriptedModel{steps: []application.Step{call("search_records"), {Text: "Sigue activo [1]."}}}
	seal := &countingSeal{}
	answer, err := application.Ask{Model: model, Tools: tools, Seal: seal.seal}.
		AnswerFollowUp(t.Context(), "¿Y ahora?", earlier, nil)
	if err != nil {
		t.Fatal(err)
	}
	if answer.Text != "Sigue activo [1]." {
		t.Fatalf("answer = %q", answer.Text)
	}
	if seal.calls != 1 {
		t.Fatalf("seal calls = %d, want one release for the question and the history", seal.calls)
	}
	want := []string{"¿Y ahora?", "¿Qué pasa en el norte?", "La comunidad mantiene el bloqueo.", "¿Desde cuándo?", "Desde marzo."}
	if strings.Join(seal.texts, "|") != strings.Join(want, "|") {
		t.Fatalf("sealed texts = %q, want %q", seal.texts, want)
	}
	first := model.seen[0]
	if len(first) != 3 || first[0].Earlier == nil || first[1].Earlier == nil {
		t.Fatalf("first turns = %+v, want two earlier turns then the question", first)
	}
	if got := first[0].Earlier.Answer.Value(); got != "sealed:La comunidad mantiene el bloqueo." {
		t.Fatalf("first earlier answer = %q", got)
	}
	if got := first[2].Question.Value(); got != "sealed:¿Y ahora?" {
		t.Fatalf("question = %q", got)
	}
}

// A record named only in the history has no number in this answer: citing it is refused, so the
// model must fetch it again with a tool.
func TestAFollowUpCannotCiteARecordOnlyTheHistoryMentions(t *testing.T) {
	t.Parallel()
	model := &scriptedModel{steps: []application.Step{{Text: "Sigue el bloqueo [1]."}}}
	_, err := application.Ask{Model: model, Tools: &fakeTools{}, Seal: sealed}.
		AnswerFollowUp(t.Context(), "¿Sigue?", earlier, nil)
	if !errors.Is(err, domain.ErrUnresolvedCitation) {
		t.Fatalf("err = %v, want ErrUnresolvedCitation", err)
	}
}

func TestAFollowUpRefusesAHistoryBeyondItsLimitsBeforeSealing(t *testing.T) {
	t.Parallel()
	long := strings.Repeat("ñ", application.MaxHistoryChars)
	seven := make([]application.Exchange, application.MaxHistoryTurns+1)
	for i := range seven {
		seven[i] = application.Exchange{Question: "¿Algo?", Answer: "Nada."}
	}
	cases := map[string][]application.Exchange{
		"too many turns":      seven,
		"too many characters": {{Question: "¿Algo?", Answer: long}},
		"an empty answer":     {{Question: "¿Algo?", Answer: "  "}},
		"an empty question":   {{Question: "", Answer: "Nada."}},
		"only citations":      {{Question: "¿Algo?", Answer: " [1][2] "}},
	}
	for name, history := range cases {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			seal := &countingSeal{}
			model := &scriptedModel{}
			_, err := application.Ask{Model: model, Tools: &fakeTools{}, Seal: seal.seal}.
				AnswerFollowUp(t.Context(), "¿Y ahora?", history, nil)
			if !errors.Is(err, application.ErrInvalidHistory) {
				t.Fatalf("err = %v, want ErrInvalidHistory", err)
			}
			if seal.calls != 0 || len(model.seen) != 0 {
				t.Fatalf("sealed %d times and asked the model %d times, want neither", seal.calls, len(model.seen))
			}
		})
	}
}

// The limits are what the spec states: six turns and 8,000 characters (runes, not bytes).
func TestAFollowUpAcceptsAHistoryAtItsLimits(t *testing.T) {
	t.Parallel()
	history := make([]application.Exchange, application.MaxHistoryTurns)
	per := application.MaxHistoryChars / application.MaxHistoryTurns
	for i := range history {
		history[i] = application.Exchange{Question: "¿", Answer: strings.Repeat("ñ", per-1)}
	}
	model := &scriptedModel{steps: []application.Step{{Text: "Sin registros."}}}
	if _, err := (application.Ask{Model: model, Tools: &fakeTools{}, Seal: sealed}).
		AnswerFollowUp(t.Context(), "¿Y ahora?", history, nil); err != nil {
		t.Fatal(err)
	}
	if application.MaxHistoryTurns != 6 || application.MaxHistoryChars != 8000 {
		t.Fatalf("limits = %d turns, %d characters", application.MaxHistoryTurns, application.MaxHistoryChars)
	}
}
