// Package application holds the integration read use cases: the project's API key metadata,
// media feeds and authorized-source catalog. Fetching feeds, previews and every write are in
// runtime.go.
package application

import (
	"context"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/integration/domain"
	tenancy "github.com/Dreamcoder08/sipges/apps/api-go/internal/tenancy/domain"
)

// Store reads one tenant's integration rows.
type Store interface {
	// APIKeys lists the tenant's keys, active first, then by name and id. It never reads hashes.
	APIKeys(ctx context.Context, tenantID string) ([]domain.APIKey, error)
	// Feeds lists the tenant's media feeds by id.
	Feeds(ctx context.Context, tenantID string) ([]domain.MediaFeed, error)
	// SourceState returns the tenant's Defensoría settings, or nil when none are saved.
	SourceState(ctx context.Context, tenantID string) (*domain.SourceState, error)
}

// Service answers the read routes for the resolved project.
type Service struct {
	Store Store
}

// MediaState is media-monitor.ts `state`.
type MediaState struct {
	PollMinutes int
	MaxFeeds    int
	Feeds       []domain.MediaFeed
}

// APIKeys is api-key-service.ts `list`.
func (s Service) APIKeys(ctx context.Context, scope tenancy.Scope) ([]domain.APIKey, error) {
	return s.Store.APIKeys(ctx, scope.TenantID())
}

// Media is media-monitor.ts `state`.
func (s Service) Media(ctx context.Context, scope tenancy.Scope) (MediaState, error) {
	feeds, err := s.Store.Feeds(ctx, scope.TenantID())
	return MediaState{PollMinutes: domain.PollMinutes, MaxFeeds: domain.MaxFeeds, Feeds: feeds}, err
}

// Sources is authorized-sources.ts `catalog`'s state: emptySourceState when nothing is saved.
func (s Service) Sources(ctx context.Context, scope tenancy.Scope) (domain.SourceState, error) {
	state, err := s.Store.SourceState(ctx, scope.TenantID())
	if err != nil || state == nil {
		return domain.SourceState{}, err
	}
	return *state, nil
}
