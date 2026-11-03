// Package application holds the identity use cases the Go API serves: today only resolving a
// session token to its principal (IdentityService.authenticate of the TypeScript API).
package application

import (
	"context"
	"time"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/identity/domain"
)

// SessionStore finds the active user behind a stored session hash.
type SessionStore interface {
	// FindSessionIdentity returns nil when the session is unknown, expired at `at`, or its user
	// is inactive.
	FindSessionIdentity(ctx context.Context, tokenHash string, at time.Time) (*domain.Principal, error)
}

// Service resolves session tokens. It never writes: no purge, no last-seen update.
type Service struct {
	store SessionStore
	now   func() time.Time
}

// NewService wires the store and the clock.
func NewService(store SessionStore, now func() time.Time) *Service {
	return &Service{store: store, now: now}
}

// Authenticate returns the principal of a session token, or nil for a malformed, unknown or
// expired token. Only the token's SHA-256 is ever looked up.
func (s *Service) Authenticate(ctx context.Context, token string) (*domain.Principal, error) {
	if !domain.ValidSessionToken(token) {
		return nil, nil
	}
	return s.store.FindSessionIdentity(ctx, domain.HashSessionToken(token), s.now())
}
