package infrastructure

import (
	"context"
	"errors"
	"fmt"
	"strconv"

	"github.com/jackc/pgx/v5"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/evidence/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/evidence/domain"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/database"
)

// The write of sql-attachment-store.ts (attach) and appendAudit of
// apps/api/src/platform/database/audit-trail.ts, statement for statement. Each runs on the
// Querier of the request's tenant transaction: the tenant comes from app.tenant_id, never from
// the caller, and row-level security hides records the clearance cannot see.

// Row lock: concurrent uploads to one record append to Adjuntos without losing entries.
const lockRecord = `SELECT payload FROM module_records WHERE module = $1 AND id = $2 FOR UPDATE`

const insertAttachment = `INSERT INTO attachments (tenant_id, id, storage_key, original_name, content_type,
     size_bytes, sha256, linked_module, record_module, linked_record_id, document_type,
     author, verification, notes, project_id, project_name, created_at)
   VALUES (current_setting('app.tenant_id', true), $1, $2, $3, $4, $5, $6, $7, $8, $9,
     $10, $11, $12, $13, $14, $15, $16)
   RETURNING ` + columns

const updatePayload = `UPDATE module_records SET payload = $3::jsonb, updated_at = $4
    WHERE module = $1 AND id = $2`

const insertAudit = `INSERT INTO audit (tenant_id, ts, module, record_id, action, detail)
     VALUES (current_setting('app.tenant_id', true), $1, $2, $3, $4, $5)`

// Attach inserts the metadata, appends the link to the record payload and audits it; nil when
// the linked record does not exist for this tenant and clearance (nothing is written).
func Attach(ctx context.Context, q database.Querier, in application.AttachInput) (*domain.Attachment, error) {
	var raw []byte
	err := q.QueryRow(ctx, lockRecord, in.RecordModule, in.LinkedRecordID).Scan(&raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	payload, err := domain.ParsePayload(raw)
	if err != nil {
		return nil, fmt.Errorf("evidence: linked record payload: %w", err)
	}
	projectID, projectName := domain.ProjectOf(payload, in.ScopeProjectID)
	rows, err := q.Query(ctx, insertAttachment, in.ID, in.StorageKey, in.OriginalName, in.ContentType,
		in.SizeBytes, in.SHA256, in.LinkedModule, in.RecordModule, in.LinkedRecordID, in.DocumentType,
		in.Author, in.Verification, in.Notes, projectID, projectName, in.CreatedAt)
	if err != nil {
		return nil, err
	}
	a, err := pgx.CollectOneRow(rows, scan)
	if err != nil {
		return nil, err
	}
	next, err := domain.LinkIntoPayload(payload, in.LinkedModule, domain.Link{
		ID: in.ID, FileName: in.OriginalName, DocumentType: in.LinkDocumentType, Verification: in.LinkVerification,
	})
	if err != nil {
		return nil, err
	}
	if _, err := q.Exec(ctx, updatePayload, in.RecordModule, in.LinkedRecordID, string(next), in.CreatedAt); err != nil {
		return nil, err
	}
	detail := "Evidencia adjunta: " + in.OriginalName + " (" + strconv.FormatInt(in.SizeBytes, 10) + " bytes)"
	if _, err := q.Exec(ctx, insertAudit, in.CreatedAt, in.RecordModule, in.LinkedRecordID, "UPLOAD", detail); err != nil {
		return nil, err
	}
	return &a, nil
}
