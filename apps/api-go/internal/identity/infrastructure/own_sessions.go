package infrastructure

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/identity/application"
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
		tag, err := tx.Exec(ctx, `DELETE FROM sessions
		  WHERE username = $1 AND token_hash <> $2 AND expires_at > $3::timestamptz`, username, keepTokenHash, at)
		if err != nil {
			return 0, fmt.Errorf("end other sessions: %w", err)
		}
		count := int(tag.RowsAffected())
		if count == 0 {
			return 0, nil
		}
		return count, auditSessions(ctx, tx, tenantID, audit(count))
	})
}

// auditSessions appends the row last: sessions are global, and entering the tenant drops to the
// role that cannot see them.
func auditSessions(ctx context.Context, tx pgx.Tx, tenantID string, audit application.SessionAudit) error {
	if err := database.EnterTenant(ctx, tx, tenantID); err != nil {
		return fmt.Errorf("enter tenant: %w", err)
	}
	_, err := tx.Exec(ctx, `INSERT INTO audit (tenant_id, ts, module, record_id, action, detail)
	  VALUES (current_setting('app.tenant_id', true), $1, 'Sesiones', $2, $3, $4)`,
		audit.At, audit.RecordID, audit.Action, audit.Detail)
	if err != nil {
		return fmt.Errorf("append audit: %w", err)
	}
	return nil
}
