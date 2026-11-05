package infrastructure

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/database"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/records/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/records/domain"
)

// insertRecords is importBatch's insert-only statement: a stored id is left untouched.
const insertRecords = `INSERT INTO module_records (tenant_id, module, id, payload, created_at, updated_at)
           SELECT current_setting('app.tenant_id', true), $1, x.id, x.payload, $3, $3
           FROM jsonb_to_recordset($2::jsonb) AS x(id text, payload jsonb)
           ON CONFLICT (tenant_id, module, id) DO NOTHING
           RETURNING (xmax = 0) AS inserted`

var _ application.InsertOnlyWriter = Records{}

// InsertBatch is importBatch with insertOnly: repeated ids keep their first payload, one
// statement per importChunk records, then one audit entry when anything was inserted.
func (s Records) InsertBatch(ctx context.Context, tenantID, module string, items []domain.ImportItem, note application.AuditNote, at time.Time) (int, error) {
	var rows []domain.ImportItem
	seen := map[string]bool{}
	for _, item := range items {
		if !seen[item.ID] {
			seen[item.ID] = true
			rows = append(rows, item)
		}
	}
	return database.WithTenant(ctx, s.DB, tenantID, func(ctx context.Context, q database.Querier) (int, error) {
		written := 0
		for start := 0; start < len(rows); start += importChunk {
			chunk := rows[start:min(start+importChunk, len(rows))]
			b := []byte{'['}
			for i, row := range chunk {
				if i > 0 {
					b = append(b, ',')
				}
				b = append(b, `{"id":`...)
				b = domain.AppendString(b, row.ID)
				b = append(b, `,"payload":`...)
				b = domain.AppendJSON(b, row.Payload)
				b = append(b, '}')
			}
			b = append(b, ']')
			result, err := q.Query(ctx, insertRecords, module, string(b), at)
			if err != nil {
				return written, err
			}
			inserted, err := pgx.CollectRows(result, pgx.RowTo[bool])
			if err != nil {
				return written, err
			}
			written += len(inserted)
		}
		if written > 0 {
			if err := audit(ctx, q, module, nil, note, at); err != nil {
				return written, err
			}
		}
		return written, nil
	})
}
