package infrastructure

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/database"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/prevention/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/prevention/domain"
	records "github.com/Dreamcoder08/sipges/apps/api-go/internal/records/domain"
)

// auditModule is the audit module name app.py uses for action plans.
const auditModule = "PrevencionTerritorial"

const (
	insertAction = `INSERT INTO preventive_actions (tenant_id, id, project_id, alert_id, title, responsible,
       due_date, description, status, progress, created_at, updated_at)
     VALUES (current_setting('app.tenant_id', true), $1, $2, $3, $4, $5, $6, $7,
       'Pendiente', 0, $8, $8)`

	insertLog = `INSERT INTO preventive_action_log (tenant_id, id, action_id, created_at, status, progress,
       note, evidence_url, decided_by, evidence_attachment_id, evidence_file_name, evidence_sha256)
     VALUES (current_setting('app.tenant_id', true), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`

	insertAudit = `INSERT INTO audit (tenant_id, ts, module, record_id, action, detail)
     VALUES (current_setting('app.tenant_id', true), $1, $2, $3, $4, $5)`

	// lockAction makes the reactivation check and the update one atomic step.
	lockAction = `SELECT ` + actionColumns + ` FROM preventive_actions WHERE id = $1 FOR UPDATE`

	updateAction = `UPDATE preventive_actions SET status = $2, progress = $3, updated_at = $4 WHERE id = $1`

	// updateBlock keeps the waiting time counting while the plan waits on the same party.
	updateBlock = `UPDATE preventive_actions SET blocked_by = $2, blocked_reason = $3,
       blocked_since = CASE WHEN blocked_by IS NOT DISTINCT FROM $2 AND $2 IS NOT NULL
         THEN blocked_since ELSE $4 END
     WHERE id = $1`

	getAction = `SELECT ` + actionColumns + ` FROM preventive_actions WHERE id = $1`
)

var _ application.ActionStore = Actions{}

// logEntry is insertLog's row; a nil receipt and a nil person leave their columns NULL.
type logEntry struct {
	id, actionID string
	at           time.Time
	status       domain.ActionStatus
	progress     int
	note         string
	evidenceURL  *string
	decidedBy    *string
	receipt      *domain.DecisionReceipt
}

func appendLog(ctx context.Context, q database.Querier, e logEntry) error {
	var attachment, file, sha *string
	if e.receipt != nil {
		attachment, file, sha = &e.receipt.AttachmentID, &e.receipt.FileName, &e.receipt.SHA256
	}
	_, err := q.Exec(ctx, insertLog, e.id, records.WellFormed(e.actionID), e.at, string(e.status), e.progress,
		records.WellFormed(e.note), wellFormed(e.evidenceURL), wellFormed(e.decidedBy), attachment, file, sha)
	return err
}

// wellFormed is records.WellFormed for a nullable column.
func wellFormed(s *string) *string {
	if s == nil {
		return nil
	}
	text := records.WellFormed(*s)
	return &text
}

func audit(ctx context.Context, q database.Querier, at time.Time, recordID, action, detail string) error {
	_, err := q.Exec(ctx, insertAudit, at, auditModule, records.WellFormed(recordID), action, records.WellFormed(detail))
	return err
}

// one reads the single plan a statement returns, with its history; nil when there is none.
func one(ctx context.Context, q database.Querier, sql string, args ...any) (*domain.PreventiveAction, error) {
	rows, err := q.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	actions, err := pgx.CollectRows(rows, scanAction)
	if err != nil || len(actions) == 0 {
		return nil, err
	}
	if actions, err = withHistory(ctx, q, actions); err != nil {
		return nil, err
	}
	return &actions[0], nil
}

// errNoRow is the row an insert or update of a locked plan must return.
var errNoRow = errors.New("prevention: the write returned no row")

// Create inserts the plan, its first log entry and the CREATE audit row in one transaction.
func (a Actions) Create(ctx context.Context, tenantID string, action application.NewAction, logID string) (domain.PreventiveAction, error) {
	return database.WithTenant(ctx, a.DB, tenantID, func(ctx context.Context, q database.Querier) (domain.PreventiveAction, error) {
		text := records.WellFormed
		_, err := q.Exec(ctx, insertAction, action.ID, action.ProjectID, text(action.AlertID), text(action.Title),
			text(action.Responsible), action.DueDate, text(action.Description), action.CreatedAt)
		if err != nil {
			return domain.PreventiveAction{}, err
		}
		if err = appendLog(ctx, q, logEntry{
			id: logID, actionID: action.ID, at: action.CreatedAt, status: domain.StatusPending, note: "Plan creado",
		}); err != nil {
			return domain.PreventiveAction{}, err
		}
		if err = audit(ctx, q, action.CreatedAt, action.ID, "CREATE", action.AlertID); err != nil {
			return domain.PreventiveAction{}, err
		}
		created, err := one(ctx, q, getAction, action.ID)
		if err == nil && created == nil {
			err = errNoRow
		}
		if err != nil {
			return domain.PreventiveAction{}, err
		}
		return *created, nil
	})
}

type updateResult struct {
	action  domain.PreventiveAction
	refused domain.UpdateError
}

// Update applies the change under the plan's row lock. RLS hides another tenant's plan, which
// then reads as missing.
func (a Actions) Update(ctx context.Context, tenantID, id string, guard application.Guard, change application.ActionChange) (domain.PreventiveAction, domain.UpdateError, error) {
	id = records.WellFormed(id)
	result, err := database.WithTenant(ctx, a.DB, tenantID, func(ctx context.Context, q database.Querier) (updateResult, error) {
		current, err := one(ctx, q, lockAction, id)
		if err != nil {
			return updateResult{}, err
		}
		if current == nil {
			return updateResult{refused: domain.ErrMissing}, nil
		}
		if refused := guard(*current); refused != "" {
			return updateResult{refused: refused}, nil
		}
		if _, err := q.Exec(ctx, updateAction, id, string(change.Status), change.Progress, change.CreatedAt); err != nil {
			return updateResult{}, err
		}
		if change.Block.Change {
			var by, reason *string
			var since *time.Time
			if to := change.Block.To; to != nil {
				by, reason, since = &to.By, &to.Reason, &to.Since
			}
			if _, err := q.Exec(ctx, updateBlock, id, by, wellFormed(reason), since); err != nil {
				return updateResult{}, err
			}
		}
		if err := appendLog(ctx, q, logEntry{
			id: change.ID, actionID: id, at: change.CreatedAt, status: change.Status, progress: change.Progress,
			note: change.Note, evidenceURL: &change.EvidenceURL, decidedBy: &change.DecidedBy, receipt: change.Receipt,
		}); err != nil {
			return updateResult{}, err
		}
		detail := domain.AuditDetail(change.Status, change.Note, change.Receipt)
		if err := audit(ctx, q, change.CreatedAt, id, "UPDATE", detail); err != nil {
			return updateResult{}, err
		}
		updated, err := one(ctx, q, getAction, id)
		if err == nil && updated == nil {
			err = errNoRow
		}
		if err != nil {
			return updateResult{}, err
		}
		return updateResult{action: *updated}, nil
	})
	return result.action, result.refused, err
}
