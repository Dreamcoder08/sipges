package infrastructure

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/identity/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/identity/domain"
)

// uniqueViolation is PostgreSQL's 23505.
const uniqueViolation = "23505"

// FindUserByGoogleEmail returns nil for an address no account holds.
func (s Store) FindUserByGoogleEmail(ctx context.Context, email string) (*application.StoredUser, error) {
	var u application.StoredUser
	var role string
	err := s.DB.QueryRow(ctx, `SELECT `+userColumns+` FROM users WHERE google_email = $1`, email).Scan(
		&u.Username, &u.FullName, &u.PasswordHash, &role, &u.Active,
		&u.TOTPSecretSealed, &u.TOTPEnabled, &u.TOTPLastStep, &u.GoogleEmail)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("find google user: %w", err)
	}
	u.Role = domain.Role(role)
	return &u, nil
}

// SetGoogleEmail links or unlinks an address. Sessions opened with the previous address must not
// outlive the link that allowed them.
func (s Store) SetGoogleEmail(ctx context.Context, username string, email *string) (application.AccountOutcome, error) {
	return transaction(ctx, s.DB, func(tx pgx.Tx) (application.AccountOutcome, error) {
		var current *string
		err := tx.QueryRow(ctx, `SELECT google_email FROM users WHERE username = $1 FOR UPDATE`, username).Scan(&current)
		if errors.Is(err, pgx.ErrNoRows) {
			return application.AccountMissing, nil
		}
		if err != nil {
			return "", fmt.Errorf("lock user: %w", err)
		}
		if email != nil {
			var found int
			err := tx.QueryRow(ctx, `SELECT 1 FROM users WHERE google_email = $1 AND username <> $2`, *email, username).Scan(&found)
			if err == nil {
				return application.AccountTaken, nil
			}
			if !errors.Is(err, pgx.ErrNoRows) {
				return "", fmt.Errorf("find address: %w", err)
			}
		}
		if (current == nil && email == nil) || (current != nil && email != nil && *current == *email) {
			return "", nil
		}
		if _, err := tx.Exec(ctx, `UPDATE users SET google_email = $2 WHERE username = $1`, username, email); err != nil {
			return "", fmt.Errorf("set address: %w", err)
		}
		if _, err := tx.Exec(ctx, `DELETE FROM sessions WHERE username = $1 AND via_google`, username); err != nil {
			return "", fmt.Errorf("revoke google sessions: %w", err)
		}
		return "", nil
	})
}

// linkBootstrap is one conditional UPDATE: under concurrent writers PostgreSQL re-checks
// `google_email IS NULL` on the latest row version, so a link committed meanwhile wins. Only an
// administrator still waiting for an address reports the conflict, so cold starts stay quiet once
// an administrator linked a different one.
const linkBootstrap = `WITH linked AS (
    UPDATE users SET google_email = $2::text
     WHERE username = $1::text AND role = 'admin' AND google_email IS NULL
       AND NOT EXISTS (SELECT 1 FROM users WHERE google_email = $2::text)
    RETURNING 1)
  SELECT EXISTS (SELECT 1 FROM linked),
         EXISTS (SELECT 1 FROM users
                  WHERE username = $1::text AND role = 'admin' AND google_email IS NULL)
         AND EXISTS (SELECT 1 FROM users
                      WHERE google_email = $2::text AND username <> $1::text)`

// LinkBootstrapGoogleEmail links email to an administrator that has no address yet.
func (s Store) LinkBootstrapGoogleEmail(ctx context.Context, username, email string) (application.BootstrapLink, error) {
	var linked, taken bool
	err := s.DB.QueryRow(ctx, linkBootstrap, username, email).Scan(&linked, &taken)
	var pgErr *pgconn.PgError
	switch {
	case errors.As(err, &pgErr) && pgErr.Code == uniqueViolation:
		// Another account took the address between the snapshot and the unique index check.
		return application.LinkTaken, nil
	case err != nil:
		return "", fmt.Errorf("link bootstrap address: %w", err)
	case linked:
		return application.LinkLinked, nil
	case taken:
		return application.LinkTaken, nil
	}
	return application.LinkKept, nil
}
