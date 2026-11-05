package infrastructure

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/identity/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/identity/domain"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/database"
)

// HasUsers reports whether the installation has any account.
func (s Store) HasUsers(ctx context.Context) (bool, error) {
	var found bool
	err := s.DB.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM users)`).Scan(&found)
	return found, err
}

// CreateUser is false when the username already exists.
func (s Store) CreateUser(ctx context.Context, account domain.NewAccount, passwordHash string, at time.Time) (bool, error) {
	tag, err := s.DB.Exec(ctx, `INSERT INTO users (username, full_name, password_hash, role, created_at)
	  VALUES ($1, $2, $3, $4, $5) ON CONFLICT (username) DO NOTHING`,
		account.Username, account.FullName, passwordHash, account.Role, at)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() == 1, nil
}

// ListAccounts lists every account, oldest first.
func (s Store) ListAccounts(ctx context.Context) ([]application.AccountSummary, error) {
	rows, err := s.DB.Query(ctx, `SELECT username, full_name, role, active, created_at, google_email
	  FROM users ORDER BY created_at, username`)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (application.AccountSummary, error) {
		var a application.AccountSummary
		var role string
		err := row.Scan(&a.Username, &a.FullName, &role, &a.Active, &a.CreatedAt, &a.GoogleEmail)
		a.Role = domain.Role(role)
		return a, err
	})
}

// DeactivateUser disables the user and deletes its sessions. A global advisory lock serializes
// deactivations, so two administrators cannot each pass the last-administrator guard.
func (s Store) DeactivateUser(ctx context.Context, username string) (application.AccountOutcome, error) {
	return transaction(ctx, s.DB, func(tx pgx.Tx) (application.AccountOutcome, error) {
		if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('sipges:account-deactivation', 0))`); err != nil {
			return "", fmt.Errorf("lock deactivation: %w", err)
		}
		var role string
		var active bool
		err := tx.QueryRow(ctx, `SELECT role, active FROM users WHERE username = $1 FOR UPDATE`, username).Scan(&role, &active)
		if errors.Is(err, pgx.ErrNoRows) {
			return application.AccountMissing, nil
		}
		if err != nil {
			return "", fmt.Errorf("lock user: %w", err)
		}
		if active && domain.Role(role) == domain.RoleAdmin {
			var admins int
			if err := tx.QueryRow(ctx, `SELECT count(*) FROM users WHERE active AND role = 'admin'`).Scan(&admins); err != nil {
				return "", fmt.Errorf("count administrators: %w", err)
			}
			if admins <= 1 {
				return application.AccountLastAdmin, nil
			}
		}
		if _, err := tx.Exec(ctx, `UPDATE users SET active = false WHERE username = $1`, username); err != nil {
			return "", fmt.Errorf("deactivate user: %w", err)
		}
		if _, err := tx.Exec(ctx, `DELETE FROM sessions WHERE username = $1`, username); err != nil {
			return "", fmt.Errorf("revoke sessions: %w", err)
		}
		return "", nil
	})
}

// ResetTOTPInTenant clears the second factor and every session of a user granted tenantID, and
// appends the audit row to that tenant's trail. Global writes come first: entering the tenant
// drops to the role that cannot see them.
func (s Store) ResetTOTPInTenant(ctx context.Context, username, tenantID, detail string, at time.Time) (application.AccountOutcome, error) {
	return transaction(ctx, s.DB, func(tx pgx.Tx) (application.AccountOutcome, error) {
		var found int
		err := tx.QueryRow(ctx, `SELECT 1 FROM users WHERE username = $1 FOR UPDATE`, username).Scan(&found)
		if errors.Is(err, pgx.ErrNoRows) {
			return application.AccountMissing, nil
		}
		if err != nil {
			return "", fmt.Errorf("lock user: %w", err)
		}
		err = tx.QueryRow(ctx, `SELECT 1 FROM grants WHERE username = $1 AND tenant_id = $2`, username, tenantID).Scan(&found)
		if errors.Is(err, pgx.ErrNoRows) {
			return application.AccountOutOfScope, nil
		}
		if err != nil {
			return "", fmt.Errorf("read grant: %w", err)
		}
		if _, err := tx.Exec(ctx, `UPDATE users SET totp_enabled = false, totp_secret_sealed = NULL, totp_last_step = NULL
		                           WHERE username = $1`, username); err != nil {
			return "", fmt.Errorf("clear factor: %w", err)
		}
		if _, err := tx.Exec(ctx, `DELETE FROM sessions WHERE username = $1`, username); err != nil {
			return "", fmt.Errorf("revoke sessions: %w", err)
		}
		if err := database.EnterTenant(ctx, tx, tenantID); err != nil {
			return "", fmt.Errorf("enter tenant: %w", err)
		}
		_, err = tx.Exec(ctx, `INSERT INTO audit (tenant_id, ts, module, record_id, action, detail)
		  VALUES (current_setting('app.tenant_id', true), $1, 'Cuentas', $2, 'MFA_RESET', $3)`, at, username, detail)
		if err != nil {
			return "", fmt.Errorf("append audit: %w", err)
		}
		return "", nil
	})
}
