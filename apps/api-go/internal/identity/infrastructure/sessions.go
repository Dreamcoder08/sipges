// Package infrastructure reads the identity tables the TypeScript API writes. It only verifies
// existing sessions: sign-in, MFA enrolment, Google sign-in and API keys stay in TypeScript
// until phase 4 of docs/adr/0032.
package infrastructure

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"regexp"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/identity/domain"
)

// Querier is the part of a pgx pool the session lookup uses.
type Querier interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

// HashToken is session-tokens.ts hash: the hex SHA-256 of the token, the only form stored.
func HashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

// tokenShape is what newToken produces (32 random bytes, lower-case hex); anything else is
// refused before the database is asked.
var tokenShape = regexp.MustCompile(`^[0-9a-f]{64}$`)

// Sessions finds the identity behind a session cookie.
type Sessions struct {
	DB Querier
	// Now is the clock; nil means time.Now.
	Now func() time.Time
}

// Authenticate is identity-service.ts authenticate: nil for a missing or malformed token, an
// unknown or expired session, or an inactive account.
func (s Sessions) Authenticate(ctx context.Context, token string) (*domain.Principal, error) {
	if !tokenShape.MatchString(token) {
		return nil, nil
	}
	now := time.Now
	if s.Now != nil {
		now = s.Now
	}
	// JavaScript dates carry milliseconds: the same instant compares the same way.
	at := now().Truncate(time.Millisecond)
	var p domain.Principal
	var role string
	var totp, viaGoogle bool
	err := s.DB.QueryRow(ctx,
		`SELECT u.username, u.full_name, u.role, u.totp_enabled, s.via_google
		   FROM sessions s JOIN users u ON u.username = s.username
		  WHERE s.token_hash = $1::text AND s.expires_at > $2::timestamptz AND u.active`,
		HashToken(token), at).Scan(&p.Username, &p.FullName, &role, &totp, &viaGoogle)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	p.Role = domain.Role(role)
	p.MFAEnabled = totp || viaGoogle
	return &p, nil
}
