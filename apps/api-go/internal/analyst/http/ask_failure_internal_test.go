package http

import (
	"fmt"
	"net/http"
	"testing"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/analyst/application"
)

func TestAFailedQuestionTellsThePersonAboutItsProposals(t *testing.T) {
	t.Parallel()
	cases := map[int]string{
		1: askNoAnswer + ". Antes de fallar dejó 1 propuesta pendiente de aprobación en Bandeja.",
		2: askNoAnswer + ". Antes de fallar dejó 2 propuestas pendientes de aprobación en Bandeja.",
	}
	for count, want := range cases {
		err := &application.PendingProposalsError{Count: count, Err: fmt.Errorf("%w: boom", application.ErrModel)}
		status, detail := askFailure(err)
		if status != http.StatusBadGateway || detail != want {
			t.Fatalf("count %d: askFailure = %d %q, want 502 %q", count, status, detail, want)
		}
	}
	if _, detail := askFailure(application.ErrModel); detail != askNoAnswer {
		t.Fatalf("without proposals: %q, want %q", detail, askNoAnswer)
	}
}
