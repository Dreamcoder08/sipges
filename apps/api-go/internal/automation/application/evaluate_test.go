package application

import (
	"context"
	"errors"
	"slices"
	"testing"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/automation/domain"
)

func evaluateRun(e domain.Event) ClaimedRun {
	return ClaimedRun{ID: 1, Step: &domain.Step{Kind: "evaluate", Title: "Evaluar", MinimumLevel: "Alta"}, Event: e}
}

func TestEvaluateStepReachesOnlyNarrativesItMayRead(t *testing.T) {
	record := &domain.EventRecord{Marking: "interno"}
	for name, c := range map[string]struct {
		event domain.Event
		want  bool
	}{
		"created":    {domain.Event{Module: narrativesModule, Action: "CREATE", Record: record}, true},
		"updated":    {domain.Event{Module: narrativesModule, Action: "UPDATE", Record: record}, true},
		"deleted":    {domain.Event{Module: narrativesModule, Action: "DELETE", Record: record}, false},
		"other":      {domain.Event{Module: "Eventos", Action: "CREATE", Record: record}, false},
		"no record":  {domain.Event{Module: narrativesModule, Action: "CREATE"}, false},
		"restricted": {domain.Event{Module: narrativesModule, Action: "CREATE", Record: &domain.EventRecord{Marking: "restringido"}}, false},
	} {
		t.Run(name, func(t *testing.T) {
			var levels []string
			s := Service{Evaluate: func(_ context.Context, tenantID string, _ domain.Event, level string) error {
				if tenantID != "T" {
					t.Errorf("tenant %s", tenantID)
				}
				levels = append(levels, level)
				return nil
			}}
			if err := s.execute(t.Context(), "T", evaluateRun(c.event)); err != nil {
				t.Fatal(err)
			}
			if c.want != slices.Equal(levels, []string{"Alta"}) {
				t.Fatalf("levels %v", levels)
			}
		})
	}
}

func TestEvaluateStepFailureIsTheRunsFailure(t *testing.T) {
	failure := errors.New("connection reset")
	s := Service{Evaluate: func(context.Context, string, domain.Event, string) error { return failure }}
	e := domain.Event{Module: narrativesModule, Action: "CREATE", Record: &domain.EventRecord{Marking: "interno"}}
	if err := s.execute(t.Context(), "T", evaluateRun(e)); !errors.Is(err, failure) {
		t.Fatalf("got %v", err)
	}
}

func TestEvaluateStepIsLeftToTypeScriptUntilItIsWired(t *testing.T) {
	if kinds := (Service{}).ExecutableKinds(); slices.Contains(kinds, "evaluate") {
		t.Fatalf("kinds %v", kinds)
	}
	s := Service{Evaluate: func(context.Context, string, domain.Event, string) error { return nil }}
	if kinds := s.ExecutableKinds(); !slices.Contains(kinds, "evaluate") || !slices.Contains(kinds, "notify") {
		t.Fatalf("kinds %v", kinds)
	}
	e := domain.Event{Module: narrativesModule, Action: "CREATE", Record: &domain.EventRecord{Marking: "interno"}}
	if err := (Service{}).execute(t.Context(), "T", evaluateRun(e)); !errors.Is(err, errNotExecutable) {
		t.Fatalf("got %v", err)
	}
}
