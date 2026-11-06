// Package infrastructure reads the management context's sources from PostgreSQL. They belong to
// other contexts, so only the reads apps/api/src/compose.ts wires into createManagementService
// are here, with the same SQL, order and date formatting:
//   - intelligence.allAlerts: sql-alert-store.ts `list` with limit 100 000;
//   - prevention.list: sql-action-store.ts `list`;
//   - the `Compromisos` records of sql-analytics-record-reader.ts.
//
// Every read runs inside the caller's tenant transaction, so row-level security applies.
package infrastructure

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/management/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/management/domain"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/database"
)

// alertLimit is intelligence-service.ts `allAlerts`' limit.
const alertLimit = 100_000

// commitmentsModule is the records module compose.ts reads for commitments.
const commitmentsModule = "Compromisos"

// iso is compose.ts `iso`: `${date.toISOString().slice(0, 19)}Z`.
func iso(t time.Time) string { return application.GeneratedAt(t) }

// Read loads the project's alerts, actions and commitment records; q must be a tenant
// transaction for tenantID.
func Read(ctx context.Context, q database.Querier, tenantID, projectID string) (application.Snapshot, error) {
	var s application.Snapshot
	var err error
	if s.Alerts, err = alerts(ctx, q, projectID); err != nil {
		return s, fmt.Errorf("management alerts: %w", err)
	}
	if s.Actions, err = actions(ctx, q, projectID); err != nil {
		return s, fmt.Errorf("management actions: %w", err)
	}
	if s.Records, err = records(ctx, q, tenantID); err != nil {
		return s, fmt.Errorf("management commitments: %w", err)
	}
	return s, nil
}

func alerts(ctx context.Context, q database.Querier, projectID string) ([]domain.AlertRow, error) {
	rows, err := q.Query(ctx, `SELECT id, created_at, source_url, source_type, level, score, status, reviewed_at
		FROM digital_alert_reviews WHERE project_id = $1
		ORDER BY created_at DESC, id DESC LIMIT $2`, projectID, alertLimit)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (domain.AlertRow, error) {
		var a domain.AlertRow
		var created time.Time
		var reviewed *time.Time
		if err := row.Scan(&a.ID, &created, &a.SourceURL, &a.SourceType, &a.Level, &a.Score, &a.Status, &reviewed); err != nil {
			return a, err
		}
		a.CreatedAt = iso(created)
		if reviewed != nil {
			at := iso(*reviewed)
			a.ReviewedAt = &at
		}
		return a, nil
	})
}

func actions(ctx context.Context, q database.Querier, projectID string) ([]domain.ActionRow, error) {
	rows, err := q.Query(ctx, `SELECT id, alert_id, title, responsible, due_date, status, progress, updated_at
		FROM preventive_actions WHERE project_id = $1
		ORDER BY due_date ASC, created_at DESC, id`, projectID)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (domain.ActionRow, error) {
		var a domain.ActionRow
		var updated time.Time
		err := row.Scan(&a.ID, &a.AlertID, &a.Title, &a.Responsible, &a.DueDate, &a.Status, &a.Progress, &updated)
		a.UpdatedAt = iso(updated)
		return a, err
	})
}

// errUnsecured is sql-analytics-record-reader.ts' refusal of a table without forced RLS.
var errUnsecured = errors.New("analytics requires forced tenant row-level security")

func records(ctx context.Context, q database.Querier, tenantID string) ([]domain.Record, error) {
	var present *string
	var secured bool
	if err := q.QueryRow(ctx, `SELECT to_regclass('public.module_records')::text AS present,
		COALESCE((SELECT relrowsecurity AND relforcerowsecurity FROM pg_class
		  WHERE oid = to_regclass('public.module_records')), false) AS secured`).Scan(&present, &secured); err != nil {
		return nil, err
	}
	if present == nil {
		return []domain.Record{}, nil
	}
	if !secured {
		return nil, errUnsecured
	}
	rows, err := q.Query(ctx, `SELECT id, payload FROM public.module_records
		WHERE tenant_id = $1 AND module = ANY($2::text[]) ORDER BY updated_at DESC, id`,
		tenantID, []string{commitmentsModule})
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (domain.Record, error) {
		var r domain.Record
		var raw []byte
		if err := row.Scan(&r.ID, &raw); err != nil {
			return r, err
		}
		payload, err := domain.ParsePayload(raw)
		r.Payload = payload
		return r, err
	})
}
