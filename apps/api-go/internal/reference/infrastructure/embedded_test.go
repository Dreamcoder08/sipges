package infrastructure_test

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/reference/domain"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/reference/infrastructure"
)

// The embedded copies must stay the repository files the TypeScript readers serve
// (data/*.json), byte for byte: go:embed cannot reach outside the module.
func TestEmbeddedCopiesMatchTheRepositoryFiles(t *testing.T) {
	for _, name := range []string{"project_coordinates.json", "canonical_entities.json"} {
		repo, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "..", "data", name))
		if err != nil {
			t.Fatal(err)
		}
		embedded, err := os.ReadFile(filepath.Join("data", name))
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(repo, embedded) {
			t.Errorf("internal/reference/infrastructure/data/%s differs from data/%s: copy it again", name, name)
		}
	}
}

func TestEmbeddedReaderServesOnlyTheRegisteredTenant(t *testing.T) {
	r, err := infrastructure.NewEmbeddedReader()
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	registered := domain.Scope{CompanyID: "SIPGES", ProjectID: "PRJ-SECHURA"}
	coordinates, err := r.Coordinates(ctx, registered)
	if err != nil || coordinates == nil || coordinates.ProjectID != "PRJ-SECHURA" || len(coordinates.Concessions) == 0 {
		t.Fatalf("registered coordinates: %v %v", coordinates, err)
	}
	entities, err := r.Entities(ctx, registered)
	if err != nil || len(entities) == 0 {
		t.Fatalf("registered entities: %v %v", entities, err)
	}
	for _, other := range []domain.Scope{
		{CompanyID: "ACME", ProjectID: "NORTE"},
		{CompanyID: "SIPGES", ProjectID: "NORTE"},
		{CompanyID: "ACME", ProjectID: "PRJ-SECHURA"},
	} {
		c, err := r.Coordinates(ctx, other)
		if err != nil || c != nil {
			t.Errorf("%v coordinates: %v %v", other, c, err)
		}
		e, err := r.Entities(ctx, other)
		if err != nil || e != nil {
			t.Errorf("%v entities: %v %v", other, e, err)
		}
	}
}

func TestReaderReturnsCopies(t *testing.T) {
	r, err := infrastructure.NewEmbeddedReader()
	if err != nil {
		t.Fatal(err)
	}
	scope := domain.Scope{CompanyID: "SIPGES", ProjectID: "PRJ-SECHURA"}
	first, _ := r.Coordinates(context.Background(), scope)
	first.Concessions[0].Geometry.Coordinates[0][0][0] = 999
	first.Bbox[0] = 999
	entities, _ := r.Entities(context.Background(), scope)
	for key := range entities {
		delete(entities, key)
	}
	second, _ := r.Coordinates(context.Background(), scope)
	if second.Concessions[0].Geometry.Coordinates[0][0][0] == 999 || second.Bbox[0] == 999 {
		t.Fatal("a caller changed the shared coordinates")
	}
	if again, _ := r.Entities(context.Background(), scope); len(again) == 0 {
		t.Fatal("a caller changed the shared entities")
	}
}
