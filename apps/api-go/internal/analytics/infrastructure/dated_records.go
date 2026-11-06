package infrastructure

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/analytics/domain"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/database"
)

// datedQuery is recordsQuery with each row's last update, which the conflict-risk back-test needs.
const datedQuery = `SELECT module, id, payload, updated_at FROM public.module_records
  WHERE tenant_id = $1 AND module = ANY($2::text[]) ORDER BY updated_at DESC, id`

// DatedRecords is createSqlDatedRecordReader: the rows Records reads, in one list, with their
// last update, under the same row-level security and with the same refusal of an unsecured table.
type DatedRecords struct {
	DB database.Beginner
}

// Read returns the requested modules' records, newest first across modules.
func (r DatedRecords) Read(ctx context.Context, tenantID string, modules []string) ([]domain.RiskRecord, error) {
	empty := []domain.RiskRecord{}
	if len(modules) == 0 {
		return empty, nil
	}
	return database.WithTenant(ctx, r.DB, tenantID, func(ctx context.Context, q database.Querier) ([]domain.RiskRecord, error) {
		var (
			present *string
			secured bool
		)
		if err := q.QueryRow(ctx, relation).Scan(&present, &secured); err != nil {
			return nil, err
		}
		if present == nil {
			return empty, nil
		}
		if !secured {
			return nil, ErrUnsecured
		}
		rows, err := q.Query(ctx, datedQuery, tenantID, modules)
		if err != nil {
			return nil, err
		}
		found, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (domain.RiskRecord, error) {
			var (
				out     domain.RiskRecord
				payload []byte
				updated time.Time
			)
			err := row.Scan(&out.Module, &out.ID, &payload, &updated)
			stamp := domain.ISOMillis(updated)
			out.Payload, out.UpdatedAt = payload, &stamp
			return out, err
		})
		if found == nil {
			found = empty
		}
		return found, err
	})
}
