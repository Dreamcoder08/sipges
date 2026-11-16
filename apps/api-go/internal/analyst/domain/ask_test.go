//nolint:misspell // Spanish record modules and messages in synthetic fixtures.
package domain_test

import (
	"errors"
	"testing"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/analyst/domain"
)

func TestSourcesNumberEachRecordOnceInOrderOfArrival(t *testing.T) {
	t.Parallel()
	var s domain.Sources
	a := s.Add(domain.RecordRef{Slug: "conflictos", ID: "C-1", Title: "Bloqueo de vía"})
	b := s.Add(domain.RecordRef{Slug: "actores", ID: "A-7", Title: "Comunidad Norte"})
	again := s.Add(domain.RecordRef{Slug: "conflictos", ID: "C-1", Title: "Bloqueo de vía"})
	if a != 1 || b != 2 || again != 1 {
		t.Fatalf("numbers = %d, %d, %d; want 1, 2, 1", a, b, again)
	}
	if got := len(s.All()); got != 2 {
		t.Fatalf("sources = %d, want 2", got)
	}
}

func TestCiteListsOnlyTheCitedRecordsInNumberOrder(t *testing.T) {
	t.Parallel()
	var s domain.Sources
	s.Add(domain.RecordRef{Slug: "conflictos", ID: "C-1", Title: "Bloqueo de vía"})
	s.Add(domain.RecordRef{Slug: "actores", ID: "A-7", Title: "Comunidad Norte"})
	s.Add(domain.RecordRef{Slug: "compromisos", ID: "K-3", Title: "Mesa de diálogo"})
	answer, err := domain.Cite("La mesa sigue abierta [3]. El bloqueo continúa [1][3].", &s)
	if err != nil {
		t.Fatal(err)
	}
	if answer.Text != "La mesa sigue abierta [3]. El bloqueo continúa [1][3]." {
		t.Fatalf("text = %q", answer.Text)
	}
	if len(answer.Sources) != 2 || answer.Sources[0].N != 1 || answer.Sources[1].N != 3 {
		t.Fatalf("sources = %+v, want [1] and [3]", answer.Sources)
	}
	if answer.Sources[1].ID != "K-3" || answer.Sources[1].Slug != "compromisos" {
		t.Fatalf("source 3 = %+v", answer.Sources[1])
	}
}

func TestCiteRejectsAMarkerNoToolReturned(t *testing.T) {
	t.Parallel()
	var s domain.Sources
	s.Add(domain.RecordRef{Slug: "conflictos", ID: "C-1", Title: "Bloqueo de vía"})
	_, err := domain.Cite("El bloqueo continúa [1] y hubo heridos [2].", &s)
	if !errors.Is(err, domain.ErrUnresolvedCitation) {
		t.Fatalf("err = %v, want ErrUnresolvedCitation", err)
	}
}

func TestCiteAcceptsAnAnswerWithoutRecordsOnlyWhenNoneWasFound(t *testing.T) {
	t.Parallel()
	var empty domain.Sources
	answer, err := domain.Cite("No encontré registros sobre eso.", &empty)
	if err != nil || len(answer.Sources) != 0 {
		t.Fatalf("answer = %+v, err = %v", answer, err)
	}
	var found domain.Sources
	found.Add(domain.RecordRef{Slug: "conflictos", ID: "C-1", Title: "Bloqueo de vía"})
	if _, err := domain.Cite("Hay un bloqueo en curso.", &found); !errors.Is(err, domain.ErrUncited) {
		t.Fatalf("err = %v, want ErrUncited", err)
	}
}
