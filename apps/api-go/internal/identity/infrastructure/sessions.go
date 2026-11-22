// Package infrastructure holds the identity tables, password hashes and session tokens, byte
// compatible with what the TypeScript API stores. MFA enrolment, Google sign-in and API keys stay
// in TypeScript until the next slices of T35 (docs/adr/0032 phase 4).
package infrastructure

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"regexp"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/identity/application"
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
		`SELECT u.username, u.full_name, u.role, u.totp_enabled, s.via_google, s.expires_at
		   FROM sessions s JOIN users u ON u.username = s.username
		  WHERE s.token_hash = $1::text AND s.expires_at > $2::timestamptz AND u.active`,
		HashToken(token), at).Scan(&p.Username, &p.FullName, &role, &totp, &viaGoogle, &p.SessionExpiresAt)
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

// ExtendSession runs the sliding idle expiry of application.SessionRenewal as one conditional
// UPDATE on the token hash: an expired session, one with enough time left, or one the absolute
// cap holds is not written. It returns the new expiry when it wrote one.
func (s Sessions) ExtendSession(ctx context.Context, tokenHash string, r application.SessionRenewal) (time.Time, bool, error) {
	var expires time.Time
	err := s.DB.QueryRow(ctx,
		`UPDATE sessions
		    SET expires_at = LEAST(created_at + make_interval(secs => $4::int), $3::timestamptz)
		  WHERE token_hash = $1::text AND expires_at > $2::timestamptz AND expires_at < $5::timestamptz
		    AND LEAST(created_at + make_interval(secs => $4::int), $3::timestamptz) > expires_at
		RETURNING expires_at`,
		tokenHash, r.At, r.IdleUntil, r.AbsoluteSeconds, r.RenewBefore).Scan(&expires)
	if errors.Is(err, pgx.ErrNoRows) {
		return time.Time{}, false, nil
	}
	if err != nil {
		return time.Time{}, false, err
	}
	return expires, true, nil
}
