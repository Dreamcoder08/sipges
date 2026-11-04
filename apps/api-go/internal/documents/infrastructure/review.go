// Package infrastructure reads the document lab's verification inbox from PostgreSQL with the
// queries of apps/api/src/contexts/documents/infrastructure/sql-review-store.ts (list) and
// apps/api/src/contexts/records/infrastructure/sql-record-store.ts (existing), inside the tenant
// transaction (docs/adr/0003): RLS keeps every row inside the tenant, and module_records rows
// marked 'restringido' stay hidden from a limited clearance.
package infrastructure

import (
	"context"

	"github.com/jackc/pgx/v5"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/documents/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/documents/domain"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/database"
)

const byProject = `project_id = $1 AND ($2::text IS NULL OR status = $2)`

const listItems = `SELECT id, project_id, source_file, source_sha256, location, theme, excerpt, action,
       status, reviewer, note, created_at, updated_at
  FROM document_review
 WHERE ` + byProject + ` AND ($3::text IS NULL OR theme = $3)
 ORDER BY created_at DESC, id DESC LIMIT $4 OFFSET $5`

const countMatching = `SELECT count(*) AS total FROM document_review
 WHERE ` + byProject + ` AND ($3::text IS NULL OR theme = $3)`

const countThemes = `SELECT theme, count(*) AS total FROM document_review
 WHERE ` + byProject + ` GROUP BY theme ORDER BY theme`

const existingRecords = `SELECT id FROM module_records WHERE module = $1 AND id = ANY($2::text[])`

// Reviews is the read side of the SQL review store.
type Reviews struct {
	DB database.Beginner
}

var _ application.ReviewStore = Reviews{}

// List returns one page, the matching total and the per-theme counts in one tenant transaction.
func (s Reviews) List(ctx context.Context, tenantID string, q application.ReviewQuery) (application.ReviewPage, error) {
	return database.WithTenant(ctx, s.DB, tenantID, func(ctx context.Context, tx database.Querier) (application.ReviewPage, error) {
		var page application.ReviewPage
		rows, err := tx.Query(ctx, listItems, q.ProjectID, q.Status, q.Theme, q.Limit, q.Offset)
		if err != nil {
			return page, err
		}
		page.Items, err = pgx.CollectRows(rows, scanItem)
		if err != nil {
			return page, err
		}
		if err := tx.QueryRow(ctx, countMatching, q.ProjectID, q.Status, q.Theme).Scan(&page.Total); err != nil {
			return page, err
		}
		rows, err = tx.Query(ctx, countThemes, q.ProjectID, q.Status)
		if err != nil {
			return page, err
		}
		defer rows.Close()
		for rows.Next() {
			var (
				theme string
				total int64
			)
			if err := rows.Scan(&theme, &total); err != nil {
				return page, err
			}
			page.Themes.Add(theme, total)
		}
		return page, rows.Err()
	})
}

func scanItem(row pgx.CollectableRow) (domain.ReviewItem, error) {
	var it domain.ReviewItem
	err := row.Scan(&it.ID, &it.ProjectID, &it.SourceFile, &it.SourceSHA256, &it.Location, &it.Theme,
		&it.Excerpt, &it.Action, &it.Status, &it.Reviewer, &it.Note, &it.CreatedAt, &it.UpdatedAt)
	return it, err
}

// ExistingRecords returns which ids exist in module, as the tenant's clearance sees them.
func (s Reviews) ExistingRecords(ctx context.Context, tenantID, module string, ids []string) (map[string]bool, error) {
	return database.WithTenant(ctx, s.DB, tenantID, func(ctx context.Context, tx database.Querier) (map[string]bool, error) {
		rows, err := tx.Query(ctx, existingRecords, module, ids)
		if err != nil {
			return nil, err
		}
		ids, err := pgx.CollectRows(rows, pgx.RowTo[string])
		if err != nil {
			return nil, err
		}
		found := make(map[string]bool, len(ids))
		for _, id := range ids {
			found[id] = true
		}
		return found, nil
	})
}
