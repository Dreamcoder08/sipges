package infrastructure

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/identity/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/identity/domain"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/database"
)

// DB is the pool the identity store runs on: users, sessions and login_failures are global
// tables, so it never enters a tenant here.
type DB interface {
	database.Beginner
	database.Querier
}

// Store is sql-identity-store.ts.
type Store struct {
	DB DB
}

// transaction is sql.transaction: fn's error rolls back.
func transaction[T any](ctx context.Context, db database.Beginner, fn func(pgx.Tx) (T, error)) (T, error) {
	var zero T
	tx, err := db.Begin(ctx)
	if err != nil {
		return zero, fmt.Errorf("begin identity transaction: %w", err)
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()
	result, err := fn(tx)
	if err != nil {
		return zero, err
	}
	if err := tx.Commit(ctx); err != nil {
		return zero, fmt.Errorf("commit identity transaction: %w", err)
	}
	return result, nil
}

const userColumns = `username, full_name, password_hash, role, active, totp_secret_sealed, totp_enabled, totp_last_step, google_email`

// FindUser returns nil for an unknown username.
func (s Store) FindUser(ctx context.Context, username string) (*application.StoredUser, error) {
	var u application.StoredUser
	var role string
	err := s.DB.QueryRow(ctx, `SELECT `+userColumns+` FROM users WHERE username = $1`, username).Scan(
		&u.Username, &u.FullName, &u.PasswordHash, &role, &u.Active,
		&u.TOTPSecretSealed, &u.TOTPEnabled, &u.TOTPLastStep, &u.GoogleEmail)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("find user: %w", err)
	}
	u.Role = domain.Role(role)
	return &u, nil
}

// UpdatePasswordHash replaces a stored hash.
func (s Store) UpdatePasswordHash(ctx context.Context, username, passwordHash string) error {
	_, err := s.DB.Exec(ctx, `UPDATE users SET password_hash = $2 WHERE username = $1`, username, passwordHash)
	return err
}

// ConsumeTOTPStep records a used step only if it is newer than the stored one, in one statement,
// so of two logins racing with one code only the first passes.
func (s Store) ConsumeTOTPStep(ctx context.Context, username string, step int64) (bool, error) {
	tag, err := s.DB.Exec(ctx, `UPDATE users SET totp_last_step = $2
	  WHERE username = $1 AND (totp_last_step IS NULL OR totp_last_step < $2)`, username, step)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() == 1, nil
}

// StartTOTPEnrollment replaces a pending secret; it is false while MFA is enabled.
func (s Store) StartTOTPEnrollment(ctx context.Context, username, sealedSecret string) (bool, error) {
	tag, err := s.DB.Exec(ctx, `UPDATE users SET totp_secret_sealed = $2, totp_last_step = NULL
	  WHERE username = $1 AND totp_enabled = false`, username, sealedSecret)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() == 1, nil
}

// EnableTOTP enables MFA and revokes every other session of the user, atomically.
func (s Store) EnableTOTP(ctx context.Context, username string, step int64, keepTokenHash string) error {
	_, err := transaction(ctx, s.DB, func(tx pgx.Tx) (struct{}, error) {
		if _, err := tx.Exec(ctx, `UPDATE users SET totp_enabled = true, totp_last_step = $2 WHERE username = $1`, username, step); err != nil {
			return struct{}{}, fmt.Errorf("enable totp: %w", err)
		}
		if _, err := tx.Exec(ctx, `DELETE FROM sessions WHERE username = $1 AND token_hash <> $2`, username, keepTokenHash); err != nil {
			return struct{}{}, fmt.Errorf("revoke sessions: %w", err)
		}
		return struct{}{}, nil
	})
	return err
}

// CreateSession holds a row lock on the active user through the insert, so a deactivation
// cannot pass between them; false means it won the race.
func (s Store) CreateSession(ctx context.Context, tokenHash, username string, expiresAt, at time.Time, viaGoogle bool) (bool, error) {
	return transaction(ctx, s.DB, func(tx pgx.Tx) (bool, error) {
		var found string
		err := tx.QueryRow(ctx, `SELECT username FROM users WHERE username = $1 AND active FOR SHARE`, username).Scan(&found)
		if errors.Is(err, pgx.ErrNoRows) {
			return false, nil
		}
		if err != nil {
			return false, fmt.Errorf("lock user: %w", err)
		}
		_, err = tx.Exec(ctx, `INSERT INTO sessions (token_hash, username, expires_at, created_at, via_google)
		                       VALUES ($1, $2, $3, $4, $5)`, tokenHash, username, expiresAt, at, viaGoogle)
		if err != nil {
			return false, fmt.Errorf("insert session: %w", err)
		}
		return true, nil
	})
}

// PurgeExpiredSessions deletes every session past its expiry.
func (s Store) PurgeExpiredSessions(ctx context.Context, at time.Time) error {
	_, err := s.DB.Exec(ctx, `DELETE FROM sessions WHERE expires_at <= $1`, at)
	return err
}

// ReserveLoginAttempt takes transaction-scoped locks per subject, in a fixed order to avoid
// deadlocks ("ip:" sorts before "user:"), so concurrent bursts consume the limit instead of all
// reading the same stale count. Rows at or before the window start are purged.
func (s Store) ReserveLoginAttempt(ctx context.Context, a application.LoginAttempt) (domain.ThrottleDecision, []int64, error) {
	type reserved struct {
		decision domain.ThrottleDecision
		ids      []int64
	}
	r, err := transaction(ctx, s.DB, func(tx pgx.Tx) (reserved, error) {
		for _, subject := range []string{a.IPSubject, a.UserSubject} {
			if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, subject); err != nil {
				return reserved{}, fmt.Errorf("lock throttle subject: %w", err)
			}
		}
		if _, err := tx.Exec(ctx, `DELETE FROM login_failures WHERE failed_at <= $1`, a.WindowStart); err != nil {
			return reserved{}, fmt.Errorf("purge login failures: %w", err)
		}
		var userFailures, ipFailures int
		err := tx.QueryRow(ctx,
			`SELECT count(*) FILTER (WHERE subject = $1), count(*) FILTER (WHERE subject = $2)
			   FROM login_failures WHERE subject = ANY($3::text[]) AND failed_at > $4`,
			a.UserSubject, a.IPSubject, []string{a.UserSubject, a.IPSubject}, a.WindowStart).Scan(&userFailures, &ipFailures)
		if err != nil {
			return reserved{}, fmt.Errorf("count login failures: %w", err)
		}
		decision := domain.DecideThrottle(userFailures, ipFailures)
		if !decision.Allowed {
			return reserved{decision: decision}, nil
		}
		rows, err := tx.Query(ctx, `INSERT INTO login_failures (subject, failed_at) VALUES ($1, $3), ($2, $3) RETURNING id`,
			a.UserSubject, a.IPSubject, a.At)
		if err != nil {
			return reserved{}, fmt.Errorf("reserve login attempt: %w", err)
		}
		ids, err := pgx.CollectRows(rows, pgx.RowTo[int64])
		if err != nil {
			return reserved{}, fmt.Errorf("reserve login attempt: %w", err)
		}
		return reserved{decision, ids}, nil
	})
	return r.decision, r.ids, err
}

// ReleaseLoginAttempt removes a provisional failure after the attempt succeeded.
func (s Store) ReleaseLoginAttempt(ctx context.Context, reservation []int64) error {
	if len(reservation) == 0 {
		return nil
	}
	_, err := s.DB.Exec(ctx, `DELETE FROM login_failures WHERE id = ANY($1::bigint[])`, reservation)
	return err
}

// ClearFailures forgets every recorded failure of subject.
func (s Store) ClearFailures(ctx context.Context, subject string) error {
	_, err := s.DB.Exec(ctx, `DELETE FROM login_failures WHERE subject = $1`, subject)
	return err
}

// Tokens is session-tokens.ts: opaque bearer tokens, of which only the SHA-256 is stored.
type Tokens struct{}

// NewToken returns 64 hex characters (32 random bytes).
func (Tokens) NewToken() (string, error) {
	token := make([]byte, 32)
	if _, err := rand.Read(token); err != nil {
		return "", fmt.Errorf("session token: %w", err)
	}
	return hex.EncodeToString(token), nil
}

// Hash is HashToken.
func (Tokens) Hash(token string) string { return HashToken(token) }
