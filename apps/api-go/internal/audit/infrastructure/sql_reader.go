// Package infrastructure is the Go port of
// apps/api/src/contexts/audit/infrastructure/sql-audit-reader.ts. Every query runs inside a
// tenant transaction the caller opened, so row-level security limits it to one project.
package infrastructure

import (
	"context"

	"github.com/jackc/pgx/v5"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/audit/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/database"
)

const columns = `id, ts, module, record_id, action, detail`

// Latest returns the newest `limit` entries, newest first.
func Latest(ctx context.Context, q database.Querier, limit int) ([]application.Record, error) {
	return collect(q.Query(ctx, `SELECT `+columns+` FROM audit ORDER BY id DESC LIMIT $1`, limit))
}

// After returns up to `limit` entries after afterID, oldest first: the live activity feed
// (docs/adr/0014 §10).
func After(ctx context.Context, q database.Querier, afterID int64, limit int) ([]application.Record, error) {
	return collect(q.Query(ctx, `SELECT `+columns+` FROM audit WHERE id > $1 ORDER BY id LIMIT $2`, afterID, limit))
}

// LastID returns the newest entry id, or 0 for an empty trail.
func LastID(ctx context.Context, q database.Querier) (int64, error) {
	var id *int64
	if err := q.QueryRow(ctx, `SELECT max(id) AS id FROM audit`).Scan(&id); err != nil {
		return 0, err
	}
	if id == nil {
		return 0, nil
	}
	return *id, nil
}

func collect(rows pgx.Rows, err error) ([]application.Record, error) {
	if err != nil {
		return nil, err
	}
	out, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (application.Record, error) {
		var r application.Record
		err := row.Scan(&r.ID, &r.At, &r.Module, &r.RecordID, &r.Action, &r.Detail)
		return r, err
	})
	if out == nil && err == nil {
		out = []application.Record{}
	}
	return out, err
}
