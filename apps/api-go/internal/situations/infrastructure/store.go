// Package infrastructure keeps the situations' data with the SQL of
// apps/api/src/contexts/situations/infrastructure: project_settings, and module_records (owned by
// the records context, read only), always inside the caller's tenant transaction.
package infrastructure

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/database"
	records "github.com/Dreamcoder08/sipges/apps/api-go/internal/records/domain"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/situations/domain"
)

// Store implements application.Store.
type Store struct{}

// Settings is load of sql-project-settings-store.ts.
func (Store) Settings(ctx context.Context, q database.Querier, tenantID string) (*domain.Stored, error) {
	var raw []byte
	var by string
	var at time.Time
	err := q.QueryRow(ctx,
		`SELECT settings::text, updated_by, updated_at FROM project_settings
		  WHERE tenant_id = $1`, tenantID).Scan(&raw, &by, &at)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	settings, err := domain.DecodeObject(raw)
	if err != nil {
		return nil, err
	}
	// JavaScript's Date keeps milliseconds.
	return &domain.Stored{Settings: settings, UpdatedBy: by, UpdatedAt: at.Truncate(time.Millisecond)}, nil
}

// SettingsForUpdate is load of sql-project-settings-store.ts, keeping jsonb's key order. It holds
// the row until the transaction ends, so two updates of one project apply one after the other
// (the TypeScript loads and saves in two transactions; a single update ends the same).
func (Store) SettingsForUpdate(ctx context.Context, q database.Querier, tenantID string) (*domain.Row, error) {
	var raw []byte
	row := domain.Row{}
	err := q.QueryRow(ctx,
		`SELECT settings::text, updated_by, updated_at FROM project_settings
		  WHERE tenant_id = $1 FOR UPDATE`, tenantID).Scan(&raw, &row.UpdatedBy, &row.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if row.Settings, err = records.ParseObject(raw); err != nil {
		return nil, err
	}
	// JavaScript's Date keeps milliseconds.
	row.UpdatedAt = row.UpdatedAt.Truncate(time.Millisecond)
	return &row, nil
}

// SaveSettings is save of sql-project-settings-store.ts. A lone surrogate reaches the cast as
// its JSON.stringify escape, which PostgreSQL refuses, as it does for the TypeScript API.
func (Store) SaveSettings(ctx context.Context, q database.Querier, tenantID string, settings []byte, updatedBy string, at time.Time, detail string) error {
	if _, err := q.Exec(ctx,
		`INSERT INTO project_settings (tenant_id, settings, updated_by, updated_at)
		 VALUES ($1, $2::jsonb, $3, $4)
		 ON CONFLICT (tenant_id) DO UPDATE SET settings = EXCLUDED.settings,
		   updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at`,
		tenantID, string(settings), updatedBy, at); err != nil {
		return err
	}
	_, err := q.Exec(ctx,
		`INSERT INTO audit (tenant_id, ts, module, record_id, action, detail)
		 VALUES (current_setting('app.tenant_id', true), $1, $2, $3, $4, $5)`,
		at, "SIPGES", nil, "CONFIG_UPDATE", detail)
	return err
}

// Records is read of sql-situation-record-reader.ts.
func (Store) Records(ctx context.Context, q database.Querier, tenantID string, modules []string) ([]domain.SourceRecord, error) {
	rows, err := q.Query(ctx,
		`SELECT module, id, payload::text FROM module_records
		  WHERE tenant_id = $1 AND module = ANY($2::text[]) ORDER BY module, id`, tenantID, modules)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []domain.SourceRecord
	for rows.Next() {
		var r domain.SourceRecord
		var raw []byte
		if err := rows.Scan(&r.Module, &r.ID, &raw); err != nil {
			return nil, err
		}
		if r.Payload, err = domain.DecodeObject(raw); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}
