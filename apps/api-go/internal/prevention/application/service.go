// Package application is the read side of
// apps/api/src/contexts/prevention/application/prevention-service.ts: the scope's plans, their
// summary and the situation room. Creating and updating plans stay in TypeScript for now.
package application

import (
	"context"
	"time"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/prevention/domain"
	tenancy "github.com/Dreamcoder08/sipges/apps/api-go/internal/tenancy/domain"
)

// ActionStore reads the plans of one project inside its tenant.
type ActionStore interface {
	List(ctx context.Context, tenantID, projectID string) ([]domain.PreventiveAction, error)
}

// Service answers the prevention read routes.
type Service struct {
	Store ActionStore
	// Now is the clock that decides "today" (UTC) for the overdue rule; nil means time.Now.
	Now func() time.Time
}

// Today is today(): the UTC calendar date, YYYY-MM-DD.
func (s Service) Today() string {
	now := time.Now
	if s.Now != nil {
		now = s.Now
	}
	return now().UTC().Format(time.DateOnly)
}

// List returns the scope's plans: due date ascending, then newest first, then id.
func (s Service) List(ctx context.Context, scope tenancy.Scope) ([]domain.PreventiveAction, error) {
	return s.Store.List(ctx, scope.TenantID(), scope.ProjectID)
}

// SituationRoom is situationRoom over the scope's plans.
func (s Service) SituationRoom(ctx context.Context, scope tenancy.Scope) (domain.SituationRoom, error) {
	actions, err := s.List(ctx, scope)
	if err != nil {
		return domain.SituationRoom{}, err
	}
	return domain.NewSituationRoom(actions, s.Today()), nil
}

// Summary is preventionSummary over the scope's plans.
func (s Service) Summary(ctx context.Context, scope tenancy.Scope) (domain.Summary, error) {
	actions, err := s.List(ctx, scope)
	if err != nil {
		return domain.Summary{}, err
	}
	return domain.NewSummary(scope.ProjectID, actions, s.Today()), nil
}
