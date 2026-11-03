// Package application is the reference service of apps/api/src/contexts/reference/application:
// it wraps the reader's data in the {available, data, notice} responses.
package application

import (
	"context"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/reference/domain"
)

// Notices of the TypeScript service, verbatim.
const (
	NoCoordinatesNotice = "No hay geometría de referencia registrada para este proyecto."
	EntitiesNotice      = "Las denominaciones canónicas no reescriben los textos de las fuentes originales."
)

// Reader is ReferenceReader: the references of a scope, or nil when it has none.
type Reader interface {
	Coordinates(ctx context.Context, scope domain.Scope) (*domain.ProjectCoordinates, error)
	Entities(ctx context.Context, scope domain.Scope) (domain.CanonicalEntities, error)
}

// CoordinatesResponse is ProjectCoordinatesResponse.
type CoordinatesResponse struct {
	Available bool                       `json:"available"`
	Data      *domain.ProjectCoordinates `json:"data"`
	Notice    string                     `json:"notice"`
}

// EntitiesResponse is CanonicalEntitiesResponse; a nil Data encodes as null.
type EntitiesResponse struct {
	Available bool                     `json:"available"`
	Data      domain.CanonicalEntities `json:"data"`
	Notice    string                   `json:"notice"`
}

// Service is createReferenceService.
type Service struct{ reader Reader }

// NewService returns the service over reader.
func NewService(reader Reader) *Service { return &Service{reader: reader} }

// Coordinates answers GET /system/project-coordinates.
func (s *Service) Coordinates(ctx context.Context, scope domain.Scope) (CoordinatesResponse, error) {
	data, err := s.reader.Coordinates(ctx, scope)
	if err != nil {
		return CoordinatesResponse{}, err
	}
	if data == nil {
		return CoordinatesResponse{Notice: NoCoordinatesNotice}, nil
	}
	return CoordinatesResponse{Available: true, Data: data, Notice: data.Source.Scope}, nil
}

// Entities answers GET /system/canonical-entities.
func (s *Service) Entities(ctx context.Context, scope domain.Scope) (EntitiesResponse, error) {
	data, err := s.reader.Entities(ctx, scope)
	if err != nil {
		return EntitiesResponse{}, err
	}
	return EntitiesResponse{Available: data != nil, Data: data, Notice: EntitiesNotice}, nil
}
