package infrastructure

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/database"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/records/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/records/domain"
)

// The writes of sql-record-store.ts, statement for statement. Each change and its audit entry
// share one WithTenant transaction, so an audit row exists exactly when the change committed;
// the record_versions row comes from the module_records trigger with the transaction's actor.
// Strings reach PostgreSQL as Node sends them (domain.WellFormed); payloads as the text
// JSON.stringify gives (domain.Stringify), cast to jsonb by the server.

const insertRecord = `INSERT INTO module_records (tenant_id, module, id, payload, created_at, updated_at)
           VALUES (current_setting('app.tenant_id', true), $1, $2, $3::jsonb, $4, $4)
           ON CONFLICT DO NOTHING RETURNING id`

const updateRecord = `UPDATE module_records SET payload = $3::jsonb, updated_at = $4
         WHERE module = $1 AND id = $2 RETURNING id`

const deleteRecord = `DELETE FROM module_records WHERE module = $1 AND id = $2 RETURNING id`

const existingRecords = `SELECT id FROM module_records WHERE module = $1 AND id = ANY($2::text[])`

// mergeRecords is importBatch's merge statement (the insert-only variant serves no route).
const mergeRecords = `INSERT INTO module_records (tenant_id, module, id, payload, created_at, updated_at)
           SELECT current_setting('app.tenant_id', true), $1, x.id, x.payload, $3, $3
           FROM jsonb_to_recordset($2::jsonb) AS x(id text, payload jsonb)
           ON CONFLICT (tenant_id, module, id) DO UPDATE SET payload = module_records.payload || EXCLUDED.payload, updated_at = EXCLUDED.updated_at
           RETURNING (xmax = 0) AS inserted`

// appendAudit is appendAudit of apps/api/src/platform/database/audit-trail.ts.
const appendAudit = `INSERT INTO audit (tenant_id, ts, module, record_id, action, detail)
     VALUES (current_setting('app.tenant_id', true), $1, $2, $3, $4, $5)`

// importChunk is IMPORT_CHUNK: records per insert statement.
const importChunk = 500

var _ application.Writer = Records{}

func audit(ctx context.Context, q database.Querier, module string, recordID *string, note application.AuditNote, at time.Time) error {
	_, err := q.Exec(ctx, appendAudit, at, module, recordID, note.Action, domain.WellFormed(note.Detail))
	return err
}

// returned runs a write ... RETURNING and reports whether it returned a row.
func returned(ctx context.Context, q database.Querier, sql string, args ...any) (bool, error) {
	rows, err := q.Query(ctx, sql, args...)
	if err != nil {
		return false, err
	}
	found := rows.Next()
	rows.Close()
	return found, rows.Err()
}

// Create inserts under the first free candidate and audits it.
func (s Records) Create(ctx context.Context, tenantID, module string, candidates func(yield func(string) bool), payloadFor func(string) *domain.Object, note application.AuditNote, at time.Time) (string, error) {
	return database.WithTenant(ctx, s.DB, tenantID, func(ctx context.Context, q database.Querier) (string, error) {
		chosen := ""
		var failed error
		candidates(func(id string) bool {
			inserted, err := returned(ctx, q, insertRecord, module, domain.WellFormed(id), string(domain.Stringify(payloadFor(id))), at)
			if err != nil {
				failed = err
				return false
			}
			if !inserted {
				return true // taken: the next candidate
			}
			recordID := domain.WellFormed(id)
			if err := audit(ctx, q, module, &recordID, note, at); err != nil {
				failed = err
				return false
			}
			chosen = id
			return false
		})
		return chosen, failed
	})
}

// Replace overwrites a payload and audits it; false when the record is missing.
func (s Records) Replace(ctx context.Context, tenantID, module, id string, payload *domain.Object, note application.AuditNote, at time.Time) (bool, error) {
	return database.WithTenant(ctx, s.DB, tenantID, func(ctx context.Context, q database.Querier) (bool, error) {
		recordID := domain.WellFormed(id)
		updated, err := returned(ctx, q, updateRecord, module, recordID, string(domain.Stringify(payload)), at)
		if err != nil || !updated {
			return false, err
		}
		return true, audit(ctx, q, module, &recordID, note, at)
	})
}

// Remove deletes a record and audits it; false when the record is missing.
func (s Records) Remove(ctx context.Context, tenantID, module, id string, note application.AuditNote, at time.Time) (bool, error) {
	return database.WithTenant(ctx, s.DB, tenantID, func(ctx context.Context, q database.Querier) (bool, error) {
		recordID := domain.WellFormed(id)
		deleted, err := returned(ctx, q, deleteRecord, module, recordID)
		if err != nil || !deleted {
			return false, err
		}
		return true, audit(ctx, q, module, &recordID, note, at)
	})
}

// Existing returns the ids among ids already stored in module.
func (s Records) Existing(ctx context.Context, tenantID, module string, ids []string) (map[string]bool, error) {
	sent := make([]string, len(ids))
	for i, id := range ids {
		sent[i] = domain.WellFormed(id)
	}
	return database.WithTenant(ctx, s.DB, tenantID, func(ctx context.Context, q database.Querier) (map[string]bool, error) {
		rows, err := q.Query(ctx, existingRecords, module, sent)
		if err != nil {
			return nil, err
		}
		found, err := pgx.CollectRows(rows, pgx.RowTo[string])
		if err != nil {
			return nil, err
		}
		out := make(map[string]bool, len(found))
		for _, id := range found {
			out[id] = true
		}
		return out, nil
	})
}

// ImportBatch merges items in one transaction: repeated ids are folded in order first (a
// statement can write a row only once; later fields win, like successive updates, and each
// repeat counts as one more update), then one statement per importChunk records, then one
// audit entry for the batch.
func (s Records) ImportBatch(ctx context.Context, tenantID, module string, items []domain.ImportItem, note application.AuditNote, at time.Time) (int, int, error) {
	type folded struct {
		id      string
		payload *domain.Object
	}
	var rows []folded
	index := map[string]int{}
	repeats := 0
	for _, item := range items {
		i, known := index[item.ID]
		if !known {
			index[item.ID] = len(rows)
			rows = append(rows, folded{item.ID, item.Payload})
			continue
		}
		repeats++
		merged := rows[i].payload.Clone() // { ...known, ...item.payload }
		for _, k := range item.Payload.Keys() {
			v, _ := item.Payload.Get(k)
			merged.Set(k, v)
		}
		rows[i].payload = merged
	}
	type counts struct{ created, updated int }
	out, err := database.WithTenant(ctx, s.DB, tenantID, func(ctx context.Context, q database.Querier) (counts, error) {
		c := counts{updated: repeats}
		for start := 0; start < len(rows); start += importChunk {
			chunk := rows[start:min(start+importChunk, len(rows))]
			b := []byte{'['}
			for i, row := range chunk {
				if i > 0 {
					b = append(b, ',')
				}
				b = append(b, `{"id":`...)
				b = domain.AppendString(b, row.id)
				b = append(b, `,"payload":`...)
				b = domain.AppendJSON(b, row.payload)
				b = append(b, '}')
			}
			b = append(b, ']')
			written, err := q.Query(ctx, mergeRecords, module, string(b), at)
			if err != nil {
				return c, err
			}
			inserted, err := pgx.CollectRows(written, pgx.RowTo[bool])
			if err != nil {
				return c, err
			}
			for _, isNew := range inserted {
				if isNew {
					c.created++
				} else {
					c.updated++
				}
			}
		}
		if c.created+c.updated > 0 {
			if err := audit(ctx, q, module, nil, note, at); err != nil {
				return c, err
			}
		}
		return c, nil
	})
	return out.created, out.updated, err
}
