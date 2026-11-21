package infrastructure

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/identity/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/audittrail"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/database"
)

// ListSessions is listSessions of sql-identity-store.ts: the user's unexpired sessions, newest
// first, ties by hash so both APIs list them in the same order.
func (s Store) ListSessions(ctx context.Context, username string, at time.Time) ([]application.StoredSession, error) {
	rows, err := s.DB.Query(ctx, `SELECT token_hash, created_at, expires_at, via_google FROM sessions
	  WHERE username = $1::text AND expires_at > $2::timestamptz
	  ORDER BY created_at DESC, token_hash`, username, at)
	if err != nil {
		return nil, fmt.Errorf("list sessions: %w", err)
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (application.StoredSession, error) {
		var session application.StoredSession
		err := row.Scan(&session.TokenHash, &session.CreatedAt, &session.ExpiresAt, &session.ViaGoogle)
		return session, err
	})
}

// EndSession deletes one of username's sessions and audits it in tenantID, in one transaction.
func (s Store) EndSession(ctx context.Context, username, tokenHash, tenantID string, audit application.SessionAudit) (bool, error) {
	return transaction(ctx, s.DB, func(tx pgx.Tx) (bool, error) {
		tag, err := tx.Exec(ctx, `DELETE FROM sessions WHERE username = $1 AND token_hash = $2`, username, tokenHash)
		if err != nil {
			return false, fmt.Errorf("end session: %w", err)
		}
		if tag.RowsAffected() == 0 {
			return false, nil
		}
		return true, auditSessions(ctx, tx, tenantID, audit)
	})
}

// EndOtherSessions deletes every session of username still active at `at` but keepTokenHash
// and audits the count; expired rows wait for the purge, and ending none audits nothing.
func (s Store) EndOtherSessions(ctx context.Context, username, keepTokenHash string, at time.Time, tenantID string, audit func(int) application.SessionAudit) (int, error) {
	return transaction(ctx, s.DB, func(tx pgx.Tx) (int, error) {
		count, err := endOtherSessions(ctx, tx, username, keepTokenHash, at)
		if err != nil || count == 0 {
			return 0, err
		}
		return count, auditSessions(ctx, tx, tenantID, audit(count))
	})
}

// ReplacePassword stores the new hash of an active user and ends its other sessions as
// EndOtherSessions does, auditing the change in tenantID, in one transaction: a password that
// changed while another device stayed signed in would leave that device a way back.
func (s Store) ReplacePassword(ctx context.Context, username, passwordHash, keepTokenHash string, at time.Time, tenantID string, audit func(int) application.SessionAudit) (bool, error) {
	return transaction(ctx, s.DB, func(tx pgx.Tx) (bool, error) {
		tag, err := tx.Exec(ctx, `UPDATE users SET password_hash = $2 WHERE username = $1 AND active`, username, passwordHash)
		if err != nil {
			return false, fmt.Errorf("replace password: %w", err)
		}
		if tag.RowsAffected() == 0 {
			return false, nil
		}
		count, err := endOtherSessions(ctx, tx, username, keepTokenHash, at)
		if err != nil {
			return false, err
		}
		return true, appendAudit(ctx, tx, tenantID, "Cuentas", audit(count))
	})
}

// endOtherSessions is the delete of «sign out everywhere else»: username's sessions still active
// at `at`, but keepTokenHash.
func endOtherSessions(ctx context.Context, tx pgx.Tx, username, keepTokenHash string, at time.Time) (int, error) {
	tag, err := tx.Exec(ctx, `DELETE FROM sessions
	  WHERE username = $1 AND token_hash <> $2 AND expires_at > $3::timestamptz`, username, keepTokenHash, at)
	if err != nil {
		return 0, fmt.Errorf("end other sessions: %w", err)
	}
	return int(tag.RowsAffected()), nil
}

// auditSessions appends a row to the Sesiones trail.
func auditSessions(ctx context.Context, tx pgx.Tx, tenantID string, audit application.SessionAudit) error {
	return appendAudit(ctx, tx, tenantID, "Sesiones", audit)
}

// appendAudit appends the row last: sessions and users are global, and entering the tenant drops
// to the role that cannot see them.
func appendAudit(ctx context.Context, tx pgx.Tx, tenantID, module string, audit application.SessionAudit) error {
	if err := database.EnterTenant(ctx, tx, tenantID); err != nil {
		return fmt.Errorf("enter tenant: %w", err)
	}
	err := audittrail.Append(ctx, tx, audittrail.Entry{
		At: audit.At, Module: module, RecordID: audittrail.ID(audit.RecordID), Action: audit.Action, Detail: audit.Detail,
	})
	if err != nil {
		return fmt.Errorf("append audit: %w", err)
	}
	return nil
}
