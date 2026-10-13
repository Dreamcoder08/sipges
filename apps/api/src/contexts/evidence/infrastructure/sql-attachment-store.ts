import { appendAudit } from '../../../platform/database/audit-trail.ts';
import type { SqlClient } from '../../../platform/database/sql-client.ts';
import { withTenant } from '../../../platform/database/tenant-transaction.ts';
import type { AttachmentStore } from '../application/ports.ts';
import { type Attachment, linkIntoPayload, projectOf } from '../domain/index.ts';

type Row = {
  id: string;
  storage_key: string;
  original_name: string;
  content_type: string;
  size_bytes: string | number;
  sha256: string;
  linked_module: string;
  linked_record_id: string;
  document_type: string;
  author: string;
  verification: string;
  notes: string;
  project_id: string;
  project_name: string;
  created_at: Date | string;
};

const COLUMNS = `id, storage_key, original_name, content_type, size_bytes, sha256, linked_module,
  linked_record_id, document_type, author, verification, notes, project_id, project_name, created_at`;

const toAttachment = (row: Row): Attachment => ({
  id: row.id,
  storageKey: row.storage_key,
  originalName: row.original_name,
  contentType: row.content_type,
  sizeBytes: Number(row.size_bytes),
  sha256: row.sha256,
  linkedModule: row.linked_module,
  linkedRecordId: row.linked_record_id,
  documentType: row.document_type,
  author: row.author,
  verification: row.verification,
  notes: row.notes,
  projectId: row.project_id,
  projectName: row.project_name,
  createdAt: new Date(row.created_at),
});

/** Escapes LIKE wildcards so `q` is matched literally (app.py used LIKE %q%). */
const likePattern = (q: string) => `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;

export const createSqlAttachmentStore = (sql: SqlClient): AttachmentStore => ({
  attach: (tenantId, input) =>
    withTenant(sql, tenantId, async (tx) => {
      // Row lock: concurrent uploads to one record append to Adjuntos without losing entries.
      const [record] = await tx.query<{ payload: Record<string, unknown> }>(
        'SELECT payload FROM module_records WHERE module = $1 AND id = $2 FOR UPDATE',
        [input.recordModule, input.linkedRecordId],
      );
      if (!record) return null;
      const { projectId, projectName } = projectOf(record.payload, input.scopeProjectId);
      const [row] = await tx.query<Row>(
        `INSERT INTO attachments (tenant_id, id, storage_key, original_name, content_type,
           size_bytes, sha256, linked_module, record_module, linked_record_id, document_type,
           author, verification, notes, project_id, project_name, created_at)
         VALUES (current_setting('app.tenant_id', true), $1, $2, $3, $4, $5, $6, $7, $8, $9,
           $10, $11, $12, $13, $14, $15, $16)
         RETURNING ${COLUMNS}`,
        [
          input.id,
          input.storageKey,
          input.originalName,
          input.contentType,
          input.sizeBytes,
          input.sha256,
          input.linkedModule,
          input.recordModule,
          input.linkedRecordId,
          input.documentType,
          input.author,
          input.verification,
          input.notes,
          projectId,
          projectName,
          input.createdAt,
        ],
      );
      const payload = linkIntoPayload(record.payload, input.linkedModule, {
        id: input.id,
        fileName: input.originalName,
        documentType: input.documentType,
        verification: input.verification,
      });
      await tx.query(
        `UPDATE module_records SET payload = $3::jsonb, updated_at = $4
          WHERE module = $1 AND id = $2`,
        [input.recordModule, input.linkedRecordId, JSON.stringify(payload), input.createdAt],
      );
      await appendAudit(tx, {
        module: input.recordModule,
        recordId: input.linkedRecordId,
        action: 'UPLOAD',
        detail: `Evidencia adjunta: ${input.originalName} (${input.sizeBytes} bytes)`,
        at: input.createdAt,
      });
      return row ? toAttachment(row) : null;
    }),

  list: (tenantId, { linkedModule, linkedRecordId, q, limit }) =>
    withTenant(sql, tenantId, async (tx) =>
      (
        await tx.query<Row>(
          `SELECT ${COLUMNS} FROM attachments
            WHERE ($1::text IS NULL OR linked_module = $1)
              AND ($2::text IS NULL OR linked_record_id = $2)
              AND ($3::text IS NULL OR original_name ILIKE $3 OR document_type ILIKE $3
                   OR author ILIKE $3 OR notes ILIKE $3)
            ORDER BY created_at DESC, id DESC LIMIT $4`,
          [linkedModule, linkedRecordId, q === null ? null : likePattern(q), limit],
        )
      ).map(toAttachment),
    ),

  get: (tenantId, id) =>
    withTenant(sql, tenantId, async (tx) => {
      const [row] = await tx.query<Row>(`SELECT ${COLUMNS} FROM attachments WHERE id = $1`, [id]);
      return row ? toAttachment(row) : null;
    }),
});
