// Package application is the read side of
// apps/api/src/contexts/intelligence/application/intelligence-service.ts: the scope's territorial
// alerts, one alert and their summary. Creating and deciding alerts, the classifier, the text
// analysis and the embedder stay in TypeScript.
package application

import (
	"context"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/intelligence/domain"
	tenancy "github.com/Dreamcoder08/sipges/apps/api-go/internal/tenancy/domain"
)

// AlertStore reads territorial alerts inside one tenant.
type AlertStore interface {
	// List returns the project's alerts, newest first, at most limit.
	List(ctx context.Context, tenantID, projectID string, limit int) ([]domain.Alert, error)
	// Get returns the tenant's alert with that id, or nil.
	Get(ctx context.Context, tenantID, id string) (*domain.Alert, error)
}

// Service answers the intelligence read routes.
type Service struct {
	Store AlertStore
}

// ListAlerts is listAlerts: the scope's alerts, newest first, limit clamped to 1..200.
func (s Service) ListAlerts(ctx context.Context, scope tenancy.Scope, limit int64) ([]domain.Alert, error) {
	return s.Store.List(ctx, scope.TenantID(), scope.ProjectID, domain.ListLimit(limit))
}

// GetAlert is getAlert: the alert when it belongs to the scope's project, else nil.
func (s Service) GetAlert(ctx context.Context, scope tenancy.Scope, id string) (*domain.Alert, error) {
	if !domain.LookupID(id) {
		return nil, nil
	}
	alert, err := s.Store.Get(ctx, scope.TenantID(), id)
	if err != nil || alert == nil || alert.ProjectID != scope.ProjectID {
		return nil, err
	}
	return alert, nil
}

// Summary is summary: alertSummary over the scope's 200 newest alerts.
func (s Service) Summary(ctx context.Context, scope tenancy.Scope) (domain.Summary, error) {
	alerts, err := s.Store.List(ctx, scope.TenantID(), scope.ProjectID, domain.MaxAlertList)
	if err != nil {
		return domain.Summary{}, err
	}
	return domain.NewSummary(scope.ProjectID, alerts)
}
