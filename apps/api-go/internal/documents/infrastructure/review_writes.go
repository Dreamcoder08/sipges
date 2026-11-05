package infrastructure

import (
	"context"
	"slices"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/documents/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/documents/domain"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/database"
)

// The writes of sql-review-store.ts, statement for statement, each in one tenant transaction:
// RLS keeps every row inside the tenant, and a decision's audit row commits with it.

const columns = `id, project_id, source_file, source_sha256, location, theme, excerpt, action,
  status, reviewer, note, created_at, updated_at`

const importItem = `INSERT INTO document_review (tenant_id, id, project_id, source_file, source_sha256,
             location, theme, excerpt, action, status, created_at, updated_at)
           VALUES (current_setting('app.tenant_id', true), $1, $2, $3, $4, $5, $6, $7, $8,
             'pendiente', $9, $9)
           ON CONFLICT DO NOTHING RETURNING id`

const decideItem = `UPDATE document_review SET status = $2, reviewer = $3, note = $4, updated_at = $5
          WHERE id = $1 RETURNING ` + columns

// pending is PENDING: the WHERE over $1..$4 of a PendingSelector.
const pending = `status = 'pendiente' AND project_id = $1
  AND ($2::text[] IS NULL OR id = ANY($2::text[]))
  AND ($3::text IS NULL OR theme = $3) AND ($4::text IS NULL OR source_sha256 = $4)`

const pendingItems = `SELECT ` + columns + ` FROM document_review WHERE ` + pending + ` ORDER BY id LIMIT $5`

const countPending = `SELECT count(*) AS total FROM document_review WHERE ` + pending

// decidePending: a materialized CTE keeps the LIMIT; the row lock plus the repeated status
// check make a concurrent decision win once.
const decidePending = `WITH picked AS (
           SELECT id AS picked_id FROM document_review WHERE ` + pending + `
            ORDER BY id LIMIT $5 FOR UPDATE)
         UPDATE document_review SET status = $6, reviewer = $7, note = $8, updated_at = $9
           FROM picked WHERE id = picked.picked_id AND status = 'pendiente'
         RETURNING ` + columns

// appendAudit is appendAudit of apps/api/src/platform/database/audit-trail.ts.
const appendAudit = `INSERT INTO audit (tenant_id, ts, module, record_id, action, detail)
     VALUES (current_setting('app.tenant_id', true), $1, $2, $3, $4, $5)`

// auditModule is the audit module app.py used for review decisions.
const auditModule = "Laboratorio_Documental"

var _ application.ReviewWriter = Reviews{}

func auditDecision(ctx context.Context, q database.Querier, id string, d application.Decision) error {
	_, err := q.Exec(ctx, appendAudit, d.At, auditModule, id, "REVIEW", d.Status+" | "+d.Reviewer)
	return err
}

// selectorArgs are pendingParams: nil ids, theme or document mean any.
func selectorArgs(s application.PendingSelector) []any {
	var ids any
	if s.IDs != nil {
		ids = s.IDs
	}
	return []any{s.ProjectID, ids, s.Theme, s.SourceSHA256}
}

// ImportItems inserts each item, skipping exact duplicates; how many were new.
func (s Reviews) ImportItems(ctx context.Context, tenantID string, items []application.NewReviewItem) (int, error) {
	return database.WithTenant(ctx, s.DB, tenantID, func(ctx context.Context, q database.Querier) (int, error) {
		inserted := 0
		for _, it := range items {
			rows, err := q.Query(ctx, importItem, it.ID, it.ProjectID, it.SourceFile, it.SourceSHA256,
				it.Location, it.Theme, it.Excerpt, it.Action, it.CreatedAt)
			if err != nil {
				return inserted, err
			}
			ids, err := pgx.CollectRows(rows, pgx.RowTo[string])
			if err != nil {
				return inserted, err
			}
			inserted += len(ids)
		}
		return inserted, nil
	})
}

// Decide updates one item and audits it; nil when it does not exist in the tenant.
func (s Reviews) Decide(ctx context.Context, tenantID, id string, d application.Decision) (*domain.ReviewItem, error) {
	return database.WithTenant(ctx, s.DB, tenantID, func(ctx context.Context, q database.Querier) (*domain.ReviewItem, error) {
		rows, err := q.Query(ctx, decideItem, id, d.Status, d.Reviewer, d.Note, d.At)
		if err != nil {
			return nil, err
		}
		items, err := pgx.CollectRows(rows, scanItem)
		if err != nil || len(items) == 0 {
			return nil, err
		}
		if err := auditDecision(ctx, q, id, d); err != nil {
			return nil, err
		}
		return &items[0], nil
	})
}

// Pending returns pending items of the selector in id order.
func (s Reviews) Pending(ctx context.Context, tenantID string, sel application.PendingSelector, limit int) ([]domain.ReviewItem, error) {
	return database.WithTenant(ctx, s.DB, tenantID, func(ctx context.Context, q database.Querier) ([]domain.ReviewItem, error) {
		rows, err := q.Query(ctx, pendingItems, append(selectorArgs(sel), limit)...)
		if err != nil {
			return nil, err
		}
		return pgx.CollectRows(rows, scanItem)
	})
}

// CountPending counts the selector's pending items.
func (s Reviews) CountPending(ctx context.Context, tenantID string, sel application.PendingSelector) (int, error) {
	return database.WithTenant(ctx, s.DB, tenantID, func(ctx context.Context, q database.Querier) (int, error) {
		var total int
		err := q.QueryRow(ctx, countPending, selectorArgs(sel)...).Scan(&total)
		return total, err
	})
}

// DecidePending decides up to limit pending items, sorted by id as localeCompare orders the
// lower-case hex and ASCII ids the inbox stores, each with its audit row.
func (s Reviews) DecidePending(ctx context.Context, tenantID string, sel application.PendingSelector, d application.Decision, limit int) ([]domain.ReviewItem, error) {
	return database.WithTenant(ctx, s.DB, tenantID, func(ctx context.Context, q database.Querier) ([]domain.ReviewItem, error) {
		args := append(selectorArgs(sel), limit, d.Status, d.Reviewer, d.Note, d.At)
		rows, err := q.Query(ctx, decidePending, args...)
		if err != nil {
			return nil, err
		}
		items, err := pgx.CollectRows(rows, scanItem)
		if err != nil {
			return nil, err
		}
		slices.SortFunc(items, func(a, b domain.ReviewItem) int { return localeCompare(a.ID, b.ID) })
		for _, it := range items {
			if err := auditDecision(ctx, q, it.ID, d); err != nil {
				return nil, err
			}
		}
		return items, nil
	})
}

// localeCompare orders ids as String#localeCompare (ICU root collation) does for the ids the
// inbox writes, lower-case hexadecimal: digits before letters, which byte order agrees with.
// Other ids (imported before, or synthetic) are compared case-insensitively first, as the
// collation's primary strength does for ASCII letters and digits, then by bytes.
func localeCompare(a, b string) int {
	if c := strings.Compare(strings.ToLower(a), strings.ToLower(b)); c != 0 {
		return c
	}
	return strings.Compare(b, a) // ICU tertiary: lower case before upper case
}
