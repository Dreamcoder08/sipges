package infrastructure

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/automation/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/database"
)

// RuntimeStore is sql-automation-runtime.ts: attempt bookkeeping on automation_cursors.
type RuntimeStore struct {
	DB *pgxpool.Pool
}

const (
	// As the owner, outside any tenant: cursors are the one table whose RLS is not forced.
	dueTenants = `SELECT tenant_id FROM automation_cursors ORDER BY last_tick_finished_at ASC NULLS FIRST,tenant_id LIMIT $1`

	startAttempt = `INSERT INTO automation_cursors(tenant_id,last_audit_id,last_tick_token,last_tick_source,last_tick_started_at,last_tick_status)
      SELECT $4,COALESCE(max(id),0),$1,$2,$3,'running' FROM audit ON CONFLICT(tenant_id) DO UPDATE SET
      last_tick_token=EXCLUDED.last_tick_token,last_tick_source=EXCLUDED.last_tick_source,
      last_tick_started_at=EXCLUDED.last_tick_started_at,last_tick_finished_at=NULL,last_tick_status='running',last_tick_report=NULL,last_tick_error=''`

	finishAttempt = `UPDATE automation_cursors SET last_tick_finished_at=$1,last_tick_status=$2,last_tick_report=$3::jsonb,last_tick_error=$4 WHERE tenant_id=$5 AND last_tick_token=$6`

	attemptState = `SELECT last_tick_started_at,last_tick_finished_at,last_tick_source,last_tick_status,last_tick_report,last_tick_error FROM automation_cursors WHERE tenant_id=$1`
)

// DueTenants lists the tenants with a cursor, the longest unvisited first.
func (s RuntimeStore) DueTenants(ctx context.Context, limit int) ([]string, error) {
	rows, err := s.DB.Query(ctx, dueTenants, limit)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowTo[string])
}

// Start records a running attempt, creating the cursor at the newest audit row when the tenant
// has none.
func (s RuntimeStore) Start(ctx context.Context, tenantID, token string, source application.RuntimeSource, at time.Time) error {
	_, err := database.WithTenant(ctx, s.DB, tenantID, func(ctx context.Context, q database.Querier) (struct{}, error) {
		_, err := q.Exec(ctx, startAttempt, token, string(source), at, tenantID)
		return struct{}{}, err
	})
	return err
}

// Finish records the attempt's outcome, unless a later attempt took the cursor over.
func (s RuntimeStore) Finish(ctx context.Context, tenantID, token, status string, report *application.TickReport, errText string, at time.Time) error {
	var reportJSON *string
	if report != nil {
		b, err := json.Marshal(report)
		if err != nil {
			return err
		}
		text := string(b)
		reportJSON = &text
	}
	_, err := database.WithTenant(ctx, s.DB, tenantID, func(ctx context.Context, q database.Querier) (struct{}, error) {
		_, err := q.Exec(ctx, finishAttempt, at, status, reportJSON, errText, tenantID, token)
		return struct{}{}, err
	})
	return err
}

// State is the tenant's latest attempt, nil when none was recorded.
func (s RuntimeStore) State(ctx context.Context, tenantID string) (*application.Attempt, error) {
	return database.WithTenant(ctx, s.DB, tenantID, func(ctx context.Context, q database.Querier) (*application.Attempt, error) {
		var (
			a       application.Attempt
			started *time.Time
			source  *string
			status  *string
			report  []byte
		)
		err := q.QueryRow(ctx, attemptState, tenantID).Scan(&started, &a.FinishedAt, &source, &status, &report, &a.Error)
		if errors.Is(err, pgx.ErrNoRows) || err == nil && started == nil {
			return nil, nil
		}
		if err != nil {
			return nil, err
		}
		a.StartedAt = *started
		if source != nil {
			a.Source = application.RuntimeSource(*source)
		}
		if status != nil {
			a.Status = *status
		}
		if report != nil {
			a.ReportJSON = report
			a.Report = &application.TickReport{}
			if err := json.Unmarshal(report, a.Report); err != nil {
				return nil, err
			}
		}
		return &a, nil
	})
}
