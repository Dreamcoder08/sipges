// Package infrastructure reads preventive action plans from PostgreSQL with the queries of
// apps/api/src/contexts/prevention/infrastructure/sql-action-store.ts, inside the tenant
// transaction (docs/adr/0003).
package infrastructure

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/database"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/prevention/domain"
)

const listActions = `SELECT id, project_id, alert_id, title, responsible, due_date, description, status,
  progress, created_at, updated_at, blocked_by, blocked_reason, blocked_since
  FROM preventive_actions WHERE project_id = $1
 ORDER BY due_date ASC, created_at DESC, id`

const listHistory = `SELECT id, action_id, created_at, status, progress, note, evidence_url, decided_by,
       evidence_attachment_id, evidence_file_name, evidence_sha256
  FROM preventive_action_log WHERE action_id = ANY($1::text[])
 ORDER BY created_at DESC, id DESC`

// Actions is the read side of the SQL action store.
type Actions struct {
	DB database.Beginner
}

// List returns the project's plans with their history, in one tenant transaction.
func (a Actions) List(ctx context.Context, tenantID, projectID string) ([]domain.PreventiveAction, error) {
	return database.WithTenant(ctx, a.DB, tenantID, func(ctx context.Context, q database.Querier) ([]domain.PreventiveAction, error) {
		rows, err := q.Query(ctx, listActions, projectID)
		if err != nil {
			return nil, err
		}
		actions, err := pgx.CollectRows(rows, scanAction)
		if err != nil || len(actions) == 0 {
			return []domain.PreventiveAction{}, err
		}
		return withHistory(ctx, q, actions)
	})
}

func scanAction(row pgx.CollectableRow) (domain.PreventiveAction, error) {
	var (
		a                 domain.PreventiveAction
		status            string
		progress          int32
		blockedBy, reason *string
		blockedSince      *time.Time
	)
	err := row.Scan(&a.ID, &a.ProjectID, &a.AlertID, &a.Title, &a.Responsible, &a.DueDate, &a.Description,
		&status, &progress, &a.CreatedAt, &a.UpdatedAt, &blockedBy, &reason, &blockedSince)
	a.Status = domain.ActionStatus(status)
	a.Progress = int(progress)
	// Like `row.blocked_by && row.blocked_since`: an empty party is no block.
	if blockedBy != nil && *blockedBy != "" && blockedSince != nil {
		a.Block = &domain.ActionBlock{By: *blockedBy, Since: *blockedSince}
		if reason != nil {
			a.Block.Reason = *reason
		}
	}
	a.History = []domain.ActionLogEntry{}
	return a, err
}

// withHistory attaches each plan's log entries, newest first, with a second query.
func withHistory(ctx context.Context, q database.Querier, actions []domain.PreventiveAction) ([]domain.PreventiveAction, error) {
	ids := make([]string, len(actions))
	index := make(map[string]int, len(actions))
	for i, a := range actions {
		ids[i] = a.ID
		index[a.ID] = i
	}
	rows, err := q.Query(ctx, listHistory, ids)
	if err != nil {
		return nil, err
	}
	entries, err := pgx.CollectRows(rows, scanEntry)
	if err != nil {
		return nil, err
	}
	for _, e := range entries {
		if i, ok := index[e.ActionID]; ok {
			actions[i].History = append(actions[i].History, e)
		}
	}
	return actions, nil
}

func scanEntry(row pgx.CollectableRow) (domain.ActionLogEntry, error) {
	var (
		e                     domain.ActionLogEntry
		status                string
		progress              int32
		attachment, file, sha *string
	)
	err := row.Scan(&e.ID, &e.ActionID, &e.CreatedAt, &status, &progress, &e.Note, &e.EvidenceURL,
		&e.DecidedBy, &attachment, &file, &sha)
	e.Status = domain.ActionStatus(status)
	e.Progress = int(progress)
	// Like `log.evidence_attachment_id && log.evidence_sha256`: both must be non-empty.
	if attachment != nil && *attachment != "" && sha != nil && *sha != "" {
		e.Receipt = &domain.DecisionReceipt{AttachmentID: *attachment, SHA256: *sha}
		if file != nil {
			e.Receipt.FileName = *file
		}
	}
	return e, err
}
