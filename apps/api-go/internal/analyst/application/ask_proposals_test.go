package application_test

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/analyst/application"
)

// proposingTools files a proposal on every call, like propose_record does.
type proposingTools struct{ filed int }

func (p *proposingTools) Specs() []application.ToolSpec {
	return []application.ToolSpec{{Name: "propose_record", Description: "Propone un registro"}}
}

func (p *proposingTools) Run(_ context.Context, _ string, _ json.RawMessage) (application.ToolOutput, error) {
	p.filed++
	return application.ToolOutput{OK: true, Proposal: "P-1"}, nil
}

func TestAFailedQuestionReportsTheProposalsItFiled(t *testing.T) {
	t.Parallel()
	tools := &proposingTools{}
	model := &scriptedModel{steps: []application.Step{call("propose_record"), call("propose_record")}}
	_, err := application.Ask{Model: model, Tools: tools, Seal: sealed}.Answer(t.Context(), "Registra la reunión")
	var pending *application.PendingProposalsError
	if !errors.As(err, &pending) || pending.Count != 2 {
		t.Fatalf("err = %v, want PendingProposalsError with 2 proposals", err)
	}
	if !errors.Is(err, application.ErrModel) {
		t.Fatalf("err = %v, want the model's failure kept underneath", err)
	}
}

func TestAFailedQuestionWithoutProposalsIsUnchanged(t *testing.T) {
	t.Parallel()
	tools := &fakeTools{}
	model := &scriptedModel{}
	_, err := application.Ask{Model: model, Tools: tools, Seal: sealed}.Answer(t.Context(), "¿Y?")
	var pending *application.PendingProposalsError
	if errors.As(err, &pending) || !errors.Is(err, application.ErrModel) {
		t.Fatalf("err = %v, want ErrModel alone", err)
	}
}
