// Package infrastructure reads territorial alerts from PostgreSQL with the queries of
// apps/api/src/contexts/intelligence/infrastructure/sql-alert-store.ts, inside the tenant
// transaction (docs/adr/0003).
package infrastructure

import (
	"context"
	"encoding/json"

	"github.com/jackc/pgx/v5"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/intelligence/domain"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/database"
)

const columns = `id, project_id, created_at, source_url, source_type, excerpt, sha256, level, score,
  method, themes, signals, suggestions, semantic_active, status, analyst_note, reviewer_note,
  reviewed_at, territory, source_record, first_validator`

const listAlerts = `SELECT ` + columns + ` FROM digital_alert_reviews WHERE project_id = $1
 ORDER BY created_at DESC, id DESC LIMIT $2`

const getAlert = `SELECT ` + columns + ` FROM digital_alert_reviews WHERE id = $1`

// Alerts is the read side of the SQL alert store.
type Alerts struct {
	DB database.Beginner
}

// List returns the project's alerts, newest first, in one tenant transaction.
func (a Alerts) List(ctx context.Context, tenantID, projectID string, limit int) ([]domain.Alert, error) {
	return database.WithTenant(ctx, a.DB, tenantID, func(ctx context.Context, q database.Querier) ([]domain.Alert, error) {
		rows, err := q.Query(ctx, listAlerts, projectID, limit)
		if err != nil {
			return nil, err
		}
		alerts, err := pgx.CollectRows(rows, scanAlert)
		if alerts == nil {
			alerts = []domain.Alert{}
		}
		return alerts, err
	})
}

// Get returns the tenant's alert with that id, or nil, in one tenant transaction.
func (a Alerts) Get(ctx context.Context, tenantID, id string) (*domain.Alert, error) {
	return database.WithTenant(ctx, a.DB, tenantID, func(ctx context.Context, q database.Querier) (*domain.Alert, error) {
		rows, err := q.Query(ctx, getAlert, id)
		if err != nil {
			return nil, err
		}
		alerts, err := pgx.CollectRows(rows, scanAlert)
		if err != nil || len(alerts) == 0 {
			return nil, err
		}
		return &alerts[0], nil
	})
}

func scanAlert(row pgx.CollectableRow) (domain.Alert, error) {
	var (
		a                            domain.Alert
		score                        int32
		themes, signals, suggestions []byte
		sourceRecord                 []byte
	)
	err := row.Scan(&a.ID, &a.ProjectID, &a.CreatedAt, &a.SourceURL, &a.SourceType, &a.Excerpt, &a.SHA256,
		&a.Level, &score, &a.Method, &themes, &signals, &suggestions, &a.SemanticActive, &a.Status,
		&a.AnalystNote, &a.ReviewerNote, &a.ReviewedAt, &a.Territory, &sourceRecord, &a.FirstValidator)
	a.Score = int(score)
	a.Themes, a.Signals, a.Suggestions = json.RawMessage(themes), json.RawMessage(signals), json.RawMessage(suggestions)
	if sourceRecord != nil {
		a.SourceRecord = json.RawMessage(sourceRecord)
	}
	return a, err
}
