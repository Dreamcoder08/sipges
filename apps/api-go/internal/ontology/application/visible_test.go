package application_test

import (
	"context"
	"testing"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/ontology/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/ontology/domain"
)

// searchStore finds every row it holds, as the store's full-text query would.
type searchStore struct {
	application.Store
	rows []application.NodeRow
}

func (s searchStore) Search(context.Context, *string, string, []string, int) ([]application.NodeRow, error) {
	return s.rows, nil
}

func (s searchStore) Nodes(context.Context, []application.NodeRef) ([]application.NodeRow, error) {
	return s.rows, nil
}

func actor(id string, payload domain.Payload) application.NodeRow {
	return application.NodeRow{NodeRef: application.NodeRef{Module: "Actores", ID: id}, Payload: payload, Marking: "interno"}
}

func territoryOnly(_, field string) bool { return field == "Territorio" }

var hiddenFields = searchStore{rows: []application.NodeRow{
	actor("A-1", domain.Payload{"Territorio": "agua clara", "Notas": "postura oculta"}),
	actor("A-2", domain.Payload{"Territorio": "Sechura", "Notas": "agua oculta"}),
}}

func ids(hits []application.Hit) []string {
	out := []string{}
	for _, hit := range hits {
		out = append(out, hit.ID)
	}
	return out
}

func TestOnlyVisibleFieldsExplainAHit(t *testing.T) {
	service := application.Service{Store: hiddenFields, Visible: territoryOnly}
	hits, err := service.Search(t.Context(), domain.UnitsOf("agua"), nil, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(hits) != 1 || hits[0].ID != "A-1" || hits[0].Match == nil || hits[0].Match.Field != "Territorio" {
		t.Fatalf("%v", ids(hits))
	}
}

func TestEveryTermMustBeInAVisibleField(t *testing.T) {
	service := application.Service{Store: hiddenFields, Visible: territoryOnly}
	hits, err := service.Search(t.Context(), domain.UnitsOf("agua postura"), nil, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(hits) != 0 {
		t.Fatalf("a visible word paired with a hidden one found %v", ids(hits))
	}
}

func TestARecordFoundOnlyByMeaningIsLeftOutWithVisibleFields(t *testing.T) {
	service := application.Service{Store: hiddenFields, Visible: territoryOnly}
	found := application.Lexical{Terms: []string{"agua"}, Bounded: 10, Rows: []application.NodeRow{}}
	refs := []application.NodeRef{{Module: "Actores", ID: "A-1"}, {Module: "Actores", ID: "A-2"}}
	hits, err := service.Fuse(t.Context(), found, refs)
	if err != nil {
		t.Fatal(err)
	}
	if len(hits) != 1 || hits[0].ID != "A-1" || !hits[0].Semantic {
		t.Fatalf("%v", ids(hits))
	}
}

func TestWithoutVisibleEveryFieldExplainsAHit(t *testing.T) {
	hits, err := application.Service{Store: hiddenFields}.Search(t.Context(), domain.UnitsOf("agua"), nil, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(hits) != 2 || hits[1].Match.Field != "Notas" {
		t.Fatalf("%v", ids(hits))
	}
}
