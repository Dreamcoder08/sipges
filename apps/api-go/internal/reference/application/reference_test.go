package application_test

import (
	"context"
	"errors"
	"testing"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/reference/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/reference/domain"
)

type reader struct {
	coordinates *domain.ProjectCoordinates
	entities    domain.CanonicalEntities
	err         error
	scopes      []domain.Scope
}

func (r *reader) Coordinates(_ context.Context, s domain.Scope) (*domain.ProjectCoordinates, error) {
	r.scopes = append(r.scopes, s)
	return r.coordinates, r.err
}

func (r *reader) Entities(_ context.Context, s domain.Scope) (domain.CanonicalEntities, error) {
	r.scopes = append(r.scopes, s)
	return r.entities, r.err
}

var scope = domain.Scope{CompanyID: "SIPGES", ProjectID: "PRJ-SECHURA"}

func TestCoordinatesNoticeIsTheSourceScope(t *testing.T) {
	data := &domain.ProjectCoordinates{Source: domain.Source{Scope: "Geometría referencial"}}
	r := &reader{coordinates: data}
	got, err := application.NewService(r).Coordinates(context.Background(), scope)
	if err != nil {
		t.Fatal(err)
	}
	if !got.Available || got.Data != data || got.Notice != "Geometría referencial" {
		t.Fatalf("got %+v", got)
	}
	if len(r.scopes) != 1 || r.scopes[0] != scope {
		t.Fatalf("reader saw %v", r.scopes)
	}
}

func TestCoordinatesWithoutData(t *testing.T) {
	got, err := application.NewService(&reader{}).Coordinates(context.Background(), scope)
	if err != nil {
		t.Fatal(err)
	}
	if got.Available || got.Data != nil || got.Notice != "No hay geometría de referencia registrada para este proyecto." {
		t.Fatalf("got %+v", got)
	}
}

func TestEntitiesNoticeIsFixed(t *testing.T) {
	const notice = "Las denominaciones canónicas no reescriben los textos de las fuentes originales."
	data := domain.CanonicalEntities{"A": {CanonicalName: "C"}}
	got, err := application.NewService(&reader{entities: data}).Entities(context.Background(), scope)
	if err != nil {
		t.Fatal(err)
	}
	if !got.Available || got.Data["A"].CanonicalName != "C" || got.Notice != notice {
		t.Fatalf("got %+v", got)
	}
	none, err := application.NewService(&reader{}).Entities(context.Background(), scope)
	if err != nil {
		t.Fatal(err)
	}
	if none.Available || none.Data != nil || none.Notice != notice {
		t.Fatalf("got %+v", none)
	}
}

func TestReaderErrorsPropagate(t *testing.T) {
	boom := errors.New("boom")
	svc := application.NewService(&reader{err: boom})
	if _, err := svc.Coordinates(context.Background(), scope); !errors.Is(err, boom) {
		t.Fatalf("coordinates error %v", err)
	}
	if _, err := svc.Entities(context.Background(), scope); !errors.Is(err, boom) {
		t.Fatalf("entities error %v", err)
	}
}
