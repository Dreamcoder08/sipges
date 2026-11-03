// Package infrastructure reads module_records and record_versions from PostgreSQL with the
// queries of apps/api/src/contexts/records/infrastructure (sql-record-store.ts,
// sql-record-summary-reader.ts), inside the tenant transaction (docs/adr/0003): tenant and
// clearance come from the request scope under forced RLS.
package infrastructure

import (
	"context"
	"errors"
	"fmt"
	"math"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/database"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/records/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/records/domain"
)

const listRecords = `SELECT id, payload::text, updated_at FROM module_records
 WHERE module = $1 AND ($2::text IS NULL OR strpos(lower(id || ' ' || payload::text), lower($2)) > 0)
 ORDER BY updated_at DESC, id DESC LIMIT $3 OFFSET $4`

const getRecord = `SELECT id, payload::text, updated_at FROM module_records WHERE module = $1 AND id = $2`

const listVersions = `SELECT operation, payload::text, actor, at FROM record_versions
 WHERE module = $1 AND record_id = $2 ORDER BY id`

// matches is MATCHES of sql-record-summary-reader.ts: the same search as the per-type list.
const matches = `module = ANY($1::text[])
  AND ($2::text IS NULL OR strpos(lower(id || ' ' || payload::text), lower($2)) > 0)`

// summary is the reader's one statement for the page and the totals.
const summary = `SELECT
   (SELECT coalesce(json_agg(page ORDER BY page.position, page.updated_at DESC, page.id DESC),
                    '[]'::json)
    FROM (SELECT module, id, payload, updated_at,
                 array_position($1::text[], module) AS position
          FROM module_records WHERE ` + matches + `
          ORDER BY position, updated_at DESC, id DESC
          LIMIT $3 OFFSET $4) page)::text AS rows,
   (SELECT coalesce(json_object_agg(module, total), '{}'::json)
    FROM (SELECT module, count(*) AS total FROM module_records WHERE ` + matches + `
          GROUP BY module) totals)::text AS totals`

// Records is the read side of the SQL record store.
type Records struct {
	DB database.Beginner
}

var _ application.Store = Records{}

func scanRecord(row pgx.CollectableRow) (application.StoredRecord, error) {
	var (
		r       application.StoredRecord
		payload string
	)
	if err := row.Scan(&r.ID, &payload, &r.UpdatedAt); err != nil {
		return r, err
	}
	var err error
	r.Payload, err = domain.ParseObject([]byte(payload))
	return r, err
}

// List returns one page of a module's records, newest first.
func (s Records) List(ctx context.Context, tenantID, module string, page application.Page) ([]application.StoredRecord, error) {
	return database.WithTenant(ctx, s.DB, tenantID, func(ctx context.Context, q database.Querier) ([]application.StoredRecord, error) {
		rows, err := q.Query(ctx, listRecords, module, page.Q, page.Limit, page.Offset)
		if err != nil {
			return nil, err
		}
		return pgx.CollectRows(rows, scanRecord)
	})
}

// Get returns one record, or nil.
func (s Records) Get(ctx context.Context, tenantID, module, id string) (*application.StoredRecord, error) {
	return database.WithTenant(ctx, s.DB, tenantID, func(ctx context.Context, q database.Querier) (*application.StoredRecord, error) {
		rows, err := q.Query(ctx, getRecord, module, id)
		if err != nil {
			return nil, err
		}
		r, err := pgx.CollectExactlyOneRow(rows, scanRecord)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		if err != nil {
			return nil, err
		}
		return &r, nil
	})
}

// History returns every version of one record (also after its deletion), oldest first.
func (s Records) History(ctx context.Context, tenantID, module, id string) ([]application.StoredVersion, error) {
	return database.WithTenant(ctx, s.DB, tenantID, func(ctx context.Context, q database.Querier) ([]application.StoredVersion, error) {
		rows, err := q.Query(ctx, listVersions, module, id)
		if err != nil {
			return nil, err
		}
		return pgx.CollectRows(rows, func(row pgx.CollectableRow) (application.StoredVersion, error) {
			var (
				v       application.StoredVersion
				payload *string
			)
			if err := row.Scan(&v.Operation, &payload, &v.Actor, &v.At); err != nil {
				return v, err
			}
			if payload == nil {
				return v, nil
			}
			var err error
			v.Payload, err = domain.ParseObject([]byte(*payload))
			return v, err
		})
	})
}

// Summary reads Registros «Todos» in one statement, so page and totals are coherent.
func (s Records) Summary(ctx context.Context, tenantID string, modules []string, page application.Page) ([]application.TypedRecord, map[string]int64, error) {
	type result struct {
		rows   []application.TypedRecord
		counts map[string]int64
	}
	out, err := database.WithTenant(ctx, s.DB, tenantID, func(ctx context.Context, q database.Querier) (result, error) {
		var rowsText, totalsText string
		if err := q.QueryRow(ctx, summary, modules, page.Q, page.Limit, page.Offset).Scan(&rowsText, &totalsText); err != nil {
			return result{}, err
		}
		rows, err := summaryRows(rowsText)
		if err != nil {
			return result{}, err
		}
		counts, err := summaryCounts(totalsText)
		return result{rows, counts}, err
	})
	return out.rows, out.counts, err
}

// summaryRows reads the json_agg page as JSON.parse does (payload key order included).
func summaryRows(text string) ([]application.TypedRecord, error) {
	v, err := domain.Parse([]byte(text))
	if err != nil {
		return nil, err
	}
	list, ok := v.([]any)
	if !ok {
		return nil, fmt.Errorf("records summary: rows are %T", v)
	}
	rows := make([]application.TypedRecord, 0, len(list))
	for _, item := range list {
		o, ok := item.(*domain.Object)
		if !ok {
			return nil, fmt.Errorf("records summary: row is %T", item)
		}
		module, _ := field[string](o, "module")
		id, _ := field[string](o, "id")
		payload, ok := field[*domain.Object](o, "payload")
		if !ok {
			return nil, errors.New("records summary: payload is not an object")
		}
		at, _ := field[string](o, "updated_at")
		updated, err := time.Parse(time.RFC3339Nano, at)
		if err != nil {
			return nil, fmt.Errorf("records summary: updated_at: %w", err)
		}
		rows = append(rows, application.TypedRecord{Module: module, StoredRecord: application.StoredRecord{ID: id, Payload: payload, UpdatedAt: updated}})
	}
	return rows, nil
}

func summaryCounts(text string) (map[string]int64, error) {
	totals, err := domain.ParseObject([]byte(text))
	if err != nil {
		return nil, err
	}
	counts := make(map[string]int64, len(totals.Keys()))
	for _, module := range totals.Keys() {
		n, ok := field[float64](totals, module)
		if !ok || n < 0 || n > math.MaxInt64 {
			return nil, fmt.Errorf("records summary: total of %s", module)
		}
		counts[module] = int64(n)
	}
	return counts, nil
}

func field[T any](o *domain.Object, key string) (T, bool) {
	v, _ := o.Get(key)
	t, ok := v.(T)
	return t, ok
}
