import { appendAudit } from '../../../platform/database/audit-trail.ts';
import type { SqlClient } from '../../../platform/database/sql-client.ts';
import { withTenant } from '../../../platform/database/tenant-transaction.ts';
import type { ReviewItem, ReviewStore } from '../application/index.ts';

type Row = {
  id: string;
  project_id: string;
  source_file: string;
  source_sha256: string;
  location: string;
  theme: string;
  excerpt: string;
  action: string;
  status: ReviewItem['status'];
  reviewer: string;
  note: string;
  created_at: Date | string;
  updated_at: Date | string;
};

const toItem = (row: Row): ReviewItem => ({
  id: row.id,
  projectId: row.project_id,
  sourceFile: row.source_file,
  sourceSha256: row.source_sha256,
  location: row.location,
  theme: row.theme,
  excerpt: row.excerpt,
  action: row.action,
  status: row.status,
  reviewer: row.reviewer,
  note: row.note,
  createdAt: new Date(row.created_at),
  updatedAt: new Date(row.updated_at),
});

/** Audit module name used by app.py for review decisions. */
const AUDIT_MODULE = 'Laboratorio_Documental';

export const createSqlReviewStore = (sql: SqlClient): ReviewStore => ({
  importItems: (tenantId, items) =>
    withTenant(sql, tenantId, async (tx) => {
      let inserted = 0;
      for (const item of items) {
        const rows = await tx.query<{ id: string }>(
          `INSERT INTO document_review (tenant_id, id, project_id, source_file, source_sha256,
             location, theme, excerpt, action, status, created_at, updated_at)
           VALUES (current_setting('app.tenant_id', true), $1, $2, $3, $4, $5, $6, $7, $8,
             'pendiente', $9, $9)
           ON CONFLICT DO NOTHING RETURNING id`,
          [
            item.id,
            item.projectId,
            item.sourceFile,
            item.sourceSha256,
            item.location,
            item.theme,
            item.excerpt,
            item.action,
            item.createdAt,
          ],
        );
        inserted += rows.length;
      }
      return inserted;
    }),

  list: (tenantId, { projectId, status, limit }) =>
    withTenant(sql, tenantId, async (tx) =>
      (
        await tx.query<Row>(
          `SELECT id, project_id, source_file, source_sha256, location, theme, excerpt, action,
                  status, reviewer, note, created_at, updated_at
             FROM document_review
            WHERE project_id = $1 AND ($2::text IS NULL OR status = $2)
            ORDER BY created_at DESC, id DESC LIMIT $3`,
          [projectId, status, limit],
        )
      ).map(toItem),
    ),

  decide: (tenantId, decision) =>
    withTenant(sql, tenantId, async (tx) => {
      const updated = await tx.query<{ id: string }>(
        `UPDATE document_review SET status = $2, reviewer = $3, note = $4, updated_at = $5
          WHERE id = $1 RETURNING id`,
        [decision.id, decision.status, decision.reviewer, decision.note, decision.at],
      );
      if (updated.length === 0) return false;
      await appendAudit(tx, {
        module: AUDIT_MODULE,
        recordId: decision.id,
        action: 'REVIEW',
        detail: `${decision.status} | ${decision.reviewer}`,
        at: decision.at,
      });
      return true;
    }),
});
