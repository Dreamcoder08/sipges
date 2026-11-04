// Package infrastructure reads evidence metadata from PostgreSQL with the queries of
// apps/api/src/contexts/evidence/infrastructure/sql-attachment-store.ts. Each function runs on
// the Querier of a tenant transaction (docs/adr/0003): row-level security limits the rows to the
// tenant and hides attachments of records the clearance cannot see (migration 0013).
package infrastructure

import (
	"context"
	"errors"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/evidence/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/evidence/domain"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/database"
)

const columns = `id, storage_key, original_name, content_type, size_bytes, sha256, linked_module,
  linked_record_id, document_type, author, verification, notes, project_id, project_name, created_at`

const listAttachments = `SELECT ` + columns + ` FROM attachments
  WHERE ($1::text IS NULL OR linked_module = $1)
    AND ($2::text IS NULL OR linked_record_id = $2)
    AND ($3::text IS NULL OR original_name ILIKE $3 OR document_type ILIKE $3
         OR author ILIKE $3 OR notes ILIKE $3)
  ORDER BY created_at DESC, id DESC LIMIT $4`

const getAttachment = `SELECT ` + columns + ` FROM attachments WHERE id = $1`

// likePattern escapes LIKE wildcards so q is matched literally (app.py used LIKE %q%).
var likeEscaper = strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`)

func likePattern(q *string) *string {
	if q == nil {
		return nil
	}
	p := "%" + likeEscaper.Replace(*q) + "%"
	return &p
}

// List returns the tenant's visible attachments matching f, newest first.
func List(ctx context.Context, q database.Querier, f application.Filter) ([]domain.Attachment, error) {
	rows, err := q.Query(ctx, listAttachments, f.LinkedModule, f.LinkedRecordID, likePattern(f.Q), f.Limit)
	if err != nil {
		return nil, err
	}
	out, err := pgx.CollectRows(rows, scan)
	if out == nil {
		out = []domain.Attachment{}
	}
	return out, err
}

// Get returns the tenant's visible attachment with that id, or nil.
func Get(ctx context.Context, q database.Querier, id string) (*domain.Attachment, error) {
	rows, err := q.Query(ctx, getAttachment, id)
	if err != nil {
		return nil, err
	}
	a, err := pgx.CollectOneRow(rows, scan)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &a, nil
}

func scan(row pgx.CollectableRow) (domain.Attachment, error) {
	var a domain.Attachment
	err := row.Scan(&a.ID, &a.StorageKey, &a.OriginalName, &a.ContentType, &a.SizeBytes, &a.SHA256,
		&a.LinkedModule, &a.LinkedRecordID, &a.DocumentType, &a.Author, &a.Verification, &a.Notes,
		&a.ProjectID, &a.ProjectName, &a.CreatedAt)
	return a, err
}
