// Package infrastructure holds the reference reader: the repository files data/*.json, embedded
// in the binary as the Worker bundles them (static-reference-reader.ts).
package infrastructure

import (
	"context"
	_ "embed" // the reference files
	"fmt"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/reference/domain"
)

// Copies of data/project_coordinates.json and data/canonical_entities.json; a test keeps them
// byte-identical to the repository files.
var (
	//go:embed data/project_coordinates.json
	coordinatesJSON []byte
	//go:embed data/canonical_entities.json
	entitiesJSON []byte
)

// EmbeddedReader serves the embedded references to the registered tenant only. Each call parses
// a fresh value, as the TypeScript readers do, so no caller can change another's data.
type EmbeddedReader struct{}

// NewEmbeddedReader checks both files against the contract once, so an invalid copy stops the
// process at start instead of failing each request.
func NewEmbeddedReader() (EmbeddedReader, error) {
	if _, err := domain.ParseProjectCoordinates(coordinatesJSON); err != nil {
		return EmbeddedReader{}, fmt.Errorf("embedded reference: %w", err)
	}
	if _, err := domain.ParseCanonicalEntities(entitiesJSON); err != nil {
		return EmbeddedReader{}, fmt.Errorf("embedded reference: %w", err)
	}
	return EmbeddedReader{}, nil
}

// Coordinates returns the project coordinates of the registered tenant, nil for any other.
func (EmbeddedReader) Coordinates(_ context.Context, scope domain.Scope) (*domain.ProjectCoordinates, error) {
	if !domain.IsRegisteredScope(scope) {
		return nil, nil //nolint:nilnil // no references is a valid answer, not an error
	}
	v, err := domain.ParseProjectCoordinates(coordinatesJSON)
	if err != nil {
		return nil, err
	}
	return &v, nil
}

// Entities returns the canonical entities of the registered tenant, nil for any other.
func (EmbeddedReader) Entities(_ context.Context, scope domain.Scope) (domain.CanonicalEntities, error) {
	if !domain.IsRegisteredScope(scope) {
		return nil, nil
	}
	return domain.ParseCanonicalEntities(entitiesJSON)
}
