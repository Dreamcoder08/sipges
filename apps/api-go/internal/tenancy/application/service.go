// Package application resolves the project of each request from the user's grants
// (TenancyService.resolve and grant-cache.ts of the TypeScript API).
package application

import (
	"container/list"
	"context"
	"sync"
	"time"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/tenancy/domain"
)

// GrantStore lists a user's granted scopes ordered by company and project.
type GrantStore interface {
	ListGrants(ctx context.Context, username string) ([]domain.Scope, error)
}

// GrantCacheTTL and maxCachedUsers match grant-cache.ts: a revoked project can still resolve
// in this process for up to 30 s, as in another Worker isolate.
const (
	GrantCacheTTL  = 30 * time.Second
	maxCachedUsers = 1000
)

type cached struct {
	username string
	at       time.Time
	grants   []domain.Scope
}

// Service resolves scopes with a per-process grant cache. Only settled lookups are stored.
type Service struct {
	store GrantStore
	now   func() time.Time

	mu         sync.Mutex
	entries    map[string]*list.Element
	order      *list.List // first-insertion order, as a JavaScript Map; the oldest is evicted
	generation uint64
}

// NewService wires the store and the clock.
func NewService(store GrantStore, now func() time.Time) *Service {
	return &Service{store: store, now: now, entries: map[string]*list.Element{}, order: list.New()}
}

// Resolution is the outcome of Resolve: a scope, or the granted projects ("COMPANY/PROJECT",
// in grant order) for the 403 that asks the user to choose.
type Resolution struct {
	Scope    *domain.Scope
	Projects []string
}

// Resolve picks the request's scope from the X-SIPGES-Scope header or the scope cookie.
func (s *Service) Resolve(ctx context.Context, username, header, cookie string) (Resolution, error) {
	grants, err := s.grants(ctx, username)
	if err != nil {
		return Resolution{}, err
	}
	if scope := domain.ResolveScope(header, cookie, grants); scope != nil {
		found := *scope
		return Resolution{Scope: &found}, nil
	}
	projects := make([]string, len(grants))
	for i, g := range grants {
		projects[i] = g.String()
	}
	return Resolution{Projects: projects}, nil
}

// Forget drops a user's cached grants; a lookup already in flight then stores nothing.
func (s *Service) Forget(username string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if e, ok := s.entries[username]; ok {
		s.order.Remove(e)
		delete(s.entries, username)
	}
	s.generation++
}

func (s *Service) grants(ctx context.Context, username string) ([]domain.Scope, error) {
	now := s.now()
	s.mu.Lock()
	if e, ok := s.entries[username]; ok {
		c := e.Value.(*cached)
		if now.Sub(c.at) < GrantCacheTTL {
			s.mu.Unlock()
			return c.grants, nil
		}
	}
	started := s.generation
	s.mu.Unlock()

	grants, err := s.store.ListGrants(ctx, username)
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.generation == started {
		if e, ok := s.entries[username]; ok {
			// A JavaScript Map keeps an updated key in its original position.
			e.Value = &cached{username: username, at: now, grants: grants}
		} else {
			if len(s.entries) >= maxCachedUsers {
				oldest := s.order.Front()
				s.order.Remove(oldest)
				delete(s.entries, oldest.Value.(*cached).username)
			}
			s.entries[username] = s.order.PushBack(&cached{username: username, at: now, grants: grants})
		}
	}
	return grants, nil
}
