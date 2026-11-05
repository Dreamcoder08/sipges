package infrastructure

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/intelligence/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/intelligence/domain"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/database"
)

// auditModule is the audit module name app.py uses for the alert inbox.
const auditModule = "InteligenciaDigital"

// lockAlert reads the alert the decision is about and holds it until the transaction ends, so
// two decisions on one alert apply one after the other (the TypeScript reads it in a separate
// transaction first; the outcome of a single decision is the same).
const lockAlert = `SELECT ` + columns + ` FROM digital_alert_reviews WHERE id = $1 FOR UPDATE`

// decideAlert and recordFirstValidation are the UPDATE statements of sql-alert-store.ts.
const decideAlert = `UPDATE digital_alert_reviews SET status = $2, reviewer_note = $3, reviewed_at = $4,
   first_validator = CASE WHEN $2 IN ('Corroborado', 'En seguimiento') THEN first_validator END
  WHERE id = $1 RETURNING ` + columns

const recordFirstValidation = `UPDATE digital_alert_reviews SET first_validator = $2, first_validated_at = $3,
   reviewer_note = $4
  WHERE id = $1 RETURNING ` + columns

const insertAudit = `INSERT INTO audit (tenant_id, ts, module, record_id, action, detail, event_payload)
  VALUES (current_setting('app.tenant_id', true), $1, $2, $3, $4, $5, $6::jsonb)`

// Decisions is the decision side of the SQL alert store.
type Decisions struct {
	DB database.Beginner
}

// Decide applies d in one tenant transaction: a missing alert or one of another project is
// ErrMissing; the four-eyes rule then records a first validation, refuses the same person, or
// changes the status. Every change writes its REVIEW audit row in the same transaction.
func (s Decisions) Decide(ctx context.Context, tenantID string, d application.Decision) (application.DecisionResult, error) {
	return database.WithTenant(ctx, s.DB, tenantID, func(ctx context.Context, q database.Querier) (application.DecisionResult, error) {
		current, err := one(ctx, q, lockAlert, d.ID)
		if err != nil {
			return application.DecisionResult{}, err
		}
		if current == nil || current.ProjectID != d.ProjectID {
			return application.DecisionResult{Err: domain.ErrMissing}, nil
		}
		first := ""
		if current.FirstValidator != nil {
			first = *current.FirstValidator
		}
		switch domain.FourEyes(current.Level, current.Status, d.Status, first, d.Actor) {
		case domain.SamePerson:
			return application.DecisionResult{Err: domain.ErrSamePerson}, nil
		case domain.First:
			updated, err := one(ctx, q, recordFirstValidation, d.ID, d.Actor, d.At, d.Note)
			if err != nil || updated == nil {
				return application.DecisionResult{Err: domain.ErrMissing}, err
			}
			if err := audit(ctx, q, *updated, "REVIEW", domain.FirstValidationDetail(d.Actor), d.At); err != nil {
				return application.DecisionResult{}, err
			}
			return application.DecisionResult{Status: current.Status, PendingSecond: true}, nil
		default:
			updated, err := one(ctx, q, decideAlert, d.ID, d.Status, d.Note, d.At)
			if err != nil || updated == nil {
				return application.DecisionResult{Err: domain.ErrMissing}, err
			}
			if err := audit(ctx, q, *updated, "REVIEW", domain.DecisionDetail(d.Status, updated.FirstValidator), d.At); err != nil {
				return application.DecisionResult{}, err
			}
			return application.DecisionResult{Status: d.Status}, nil
		}
	})
}

func one(ctx context.Context, q database.Querier, sql string, args ...any) (*domain.Alert, error) {
	rows, err := q.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	alert, err := pgx.CollectExactlyOneRow(rows, scanAlert)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &alert, nil
}

// snapshot is the immutable event-time fields of sql-alert-store.ts: automation must not join a
// later mutable review. jsonb orders the keys, so their order here does not matter.
type snapshot struct {
	ID           string          `json:"id"`
	ProjectID    string          `json:"project_id"`
	Level        string          `json:"level"`
	Status       string          `json:"status"`
	Score        int             `json:"score"`
	Territory    *string         `json:"territory"`
	SourceURL    string          `json:"source_url"`
	SourceType   string          `json:"source_type"`
	SourceRecord json.RawMessage `json:"source_record"`
	SHA256       string          `json:"sha256"`
}

func audit(ctx context.Context, q database.Querier, a domain.Alert, action, detail string, at time.Time) error {
	record := a.SourceRecord
	if record == nil {
		record = json.RawMessage("null")
	}
	payload, err := json.Marshal(snapshot{
		ID: a.ID, ProjectID: a.ProjectID, Level: a.Level, Status: a.Status, Score: a.Score,
		Territory: a.Territory, SourceURL: a.SourceURL, SourceType: a.SourceType,
		SourceRecord: record, SHA256: a.SHA256,
	})
	if err != nil {
		return err
	}
	_, err = q.Exec(ctx, insertAudit, at, auditModule, a.ID, action, detail, string(payload))
	return err
}
