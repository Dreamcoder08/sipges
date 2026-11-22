//nolint:misspell // Spanish record modules in synthetic fixtures.
package application_test

import (
	"context"
	"testing"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/analyst/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/analyst/domain"
)

// One report per question: the tokens of every model call of the loop added up.
func TestAskReportsTheUsageOfTheWholeLoop(t *testing.T) {
	t.Parallel()
	refs := []domain.RecordRef{{Slug: "conflictos", ID: "C-1", Title: "Bloqueo de vía"}}
	model := &scriptedModel{steps: []application.Step{
		{Model: "m", Calls: []application.ToolCall{{ID: "1", Name: "search_records"}}, Usage: application.Usage{Input: 100, Output: 10, CacheCreation: 900}},
		{Model: "m", Text: "Sigue [1].", Usage: application.Usage{Input: 40, Output: 20, CacheRead: 900}},
	}}
	var reports []application.AskReport
	a := application.Ask{Model: model, Tools: &fakeTools{answers: map[string][]domain.RecordRef{"search_records": refs}}, Seal: sealed,
		Report: func(_ context.Context, r application.AskReport) { reports = append(reports, r) }}
	if _, err := a.Answer(t.Context(), "¿Qué pasa?"); err != nil {
		t.Fatal(err)
	}
	if len(reports) != 1 {
		t.Fatalf("reports = %+v", reports)
	}
	r := reports[0]
	want := application.Usage{Input: 140, Output: 30, CacheCreation: 900, CacheRead: 900}
	if r.Usage != want || r.Model != "m" || r.Turns != 2 || r.ToolCalls != 1 || !r.OK || r.Duration <= 0 {
		t.Fatalf("report = %+v", r)
	}
}

// A failed question is reported too, with the tokens it spent before failing.
func TestAskReportsTheUsageOfAFailedQuestion(t *testing.T) {
	t.Parallel()
	model := &scriptedModel{steps: []application.Step{{Model: "m", Text: "Hubo heridos [3].", Usage: application.Usage{Input: 7, Output: 3}}}}
	var got []application.AskReport
	a := application.Ask{Model: model, Tools: &fakeTools{}, Seal: sealed,
		Report: func(_ context.Context, r application.AskReport) { got = append(got, r) }}
	if _, err := a.Answer(t.Context(), "¿Heridos?"); err == nil {
		t.Fatal("expected an error")
	}
	if len(got) != 1 || got[0].OK || got[0].Usage != (application.Usage{Input: 7, Output: 3}) || got[0].Turns != 1 {
		t.Fatalf("reports = %+v", got)
	}
}
