// Package infrastructure holds the PostgreSQL adapters of the identity context.
package infrastructure

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/identity/domain"
)

// Querier is the part of a pgx pool the store uses. It must be the base role's pool: the
// sipges_tenant role cannot read users or sessions.
type Querier interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

// SessionStore reads sessions as sql-identity-store.ts findSessionIdentity does.
type SessionStore struct{ DB Querier }

const findSessionIdentity = `SELECT u.username, u.full_name, u.role, u.totp_enabled, s.via_google
  FROM sessions s JOIN users u ON u.username = s.username
 WHERE s.token_hash = $1::text AND s.expires_at > $2::timestamptz AND u.active`

// FindSessionIdentity implements application.SessionStore. A Google session counts as MFA (ADR 0010).
func (s SessionStore) FindSessionIdentity(ctx context.Context, tokenHash string, at time.Time) (*domain.Principal, error) {
	var p domain.Principal
	var role string
	var totp, viaGoogle bool
	err := s.DB.QueryRow(ctx, findSessionIdentity, tokenHash, at).Scan(&p.Username, &p.FullName, &role, &totp, &viaGoogle)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("find session: %w", err)
	}
	p.Role = domain.Role(role)
	p.MFAEnabled = totp || viaGoogle
	return &p, nil
}
