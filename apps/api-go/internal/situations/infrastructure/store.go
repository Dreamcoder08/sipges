// Package infrastructure reads the situations' data with the SQL of
// apps/api/src/contexts/situations/infrastructure: project_settings and module_records (owned by
// the records context), always inside the caller's tenant transaction.
package infrastructure

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/database"
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
