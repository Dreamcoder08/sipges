import { appendAudit } from '../../../platform/database/audit-trail.ts';
import type { SqlClient } from '../../../platform/database/sql-client.ts';
import { withTenant } from '../../../platform/database/tenant-transaction.ts';
import type { PendingSelector, ReviewItem, ReviewStore } from '../application/index.ts';
import { APPROVAL_STATUSES } from '../domain/index.ts';

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

const COLUMNS = `id, project_id, source_file, source_sha256, location, theme, excerpt, action,
  status, reviewer, note, created_at, updated_at`;

/** Audit module name used by app.py for review decisions. */
const AUDIT_MODULE = 'Laboratorio_Documental';

type Decision = { status: string; reviewer: string; note: string; at: Date };

/** The audit row of one review decision, shared by single and bulk decisions. */
const auditDecision = (tx: SqlClient, id: string, decision: Decision) =>
  appendAudit(tx, {
    module: AUDIT_MODULE,
    recordId: id,
    action: 'REVIEW',
    detail: `${decision.status} | ${decision.reviewer}`,
    at: decision.at,
  });

/** WHERE over `$1..$4` for a PendingSelector; RLS keeps it inside the tenant. */
const PENDING = `status = 'pendiente' AND project_id = $1
  AND ($2::text[] IS NULL OR id = ANY($2::text[]))
  AND ($3::text IS NULL OR theme = $3) AND ($4::text IS NULL OR source_sha256 = $4)`;
const pendingParams = (s: PendingSelector) => [
  s.projectId,
  s.ids ? [...s.ids] : null,
  s.theme,
  s.sourceSha256,
];

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

  list: (tenantId, { projectId, status, theme, limit, offset }) =>
    withTenant(sql, tenantId, async (tx) => {
      const byProject = 'project_id = $1 AND ($2::text IS NULL OR status = $2)';
      const rows = await tx.query<Row>(
        `SELECT id, project_id, source_file, source_sha256, location, theme, excerpt, action,
                status, reviewer, note, created_at, updated_at
           FROM document_review
          WHERE ${byProject} AND ($3::text IS NULL OR theme = $3)
          ORDER BY created_at DESC, id DESC LIMIT $4 OFFSET $5`,
        [projectId, status, theme, limit, offset],
      );
      const [matching] = await tx.query<{ total: number | string }>(
        `SELECT count(*) AS total FROM document_review
          WHERE ${byProject} AND ($3::text IS NULL OR theme = $3)`,
        [projectId, status, theme],
      );
      const counts = await tx.query<{ theme: string; total: number | string }>(
        `SELECT theme, count(*) AS total FROM document_review
          WHERE ${byProject} GROUP BY theme ORDER BY theme`,
        [projectId, status],
      );
      return {
        items: rows.map(toItem),
        total: Number(matching?.total ?? 0),
        themes: Object.fromEntries(counts.map((row) => [row.theme, Number(row.total)])),
      };
    }),

  decide: (tenantId, decision) =>
    withTenant(sql, tenantId, async (tx) => {
      const [updated] = await tx.query<Row>(
        `UPDATE document_review SET status = $2, reviewer = $3, note = $4, updated_at = $5
          WHERE id = $1 RETURNING ${COLUMNS}`,
        [decision.id, decision.status, decision.reviewer, decision.note, decision.at],
      );
      if (!updated) return null;
      await auditDecision(tx, decision.id, decision);
      return toItem(updated);
    }),

  pending: (tenantId, selector, limit) =>
    withTenant(sql, tenantId, async (tx) =>
      (
        await tx.query<Row>(
          `SELECT ${COLUMNS} FROM document_review WHERE ${PENDING} ORDER BY id LIMIT $5`,
          [...pendingParams(selector), limit],
        )
      ).map(toItem),
    ),

  countPending: (tenantId, selector) =>
    withTenant(sql, tenantId, async (tx) => {
      const [row] = await tx.query<{ total: number | string }>(
        `SELECT count(*) AS total FROM document_review WHERE ${PENDING}`,
        pendingParams(selector),
      );
      return Number(row?.total ?? 0);
    }),

  decidePending: (tenantId, selector, decision, limit) =>
    withTenant(sql, tenantId, async (tx) => {
      // A materialized CTE keeps the LIMIT (an `IN (… LIMIT)` subquery may not); the row lock
      // plus the repeated status check make a concurrent decision win once.
      const rows = await tx.query<Row>(
        `WITH picked AS (
           SELECT id AS picked_id FROM document_review WHERE ${PENDING}
            ORDER BY id LIMIT $5 FOR UPDATE)
         UPDATE document_review SET status = $6, reviewer = $7, note = $8, updated_at = $9
           FROM picked WHERE id = picked.picked_id AND status = 'pendiente'
         RETURNING ${COLUMNS}`,
        [
          ...pendingParams(selector),
          limit,
          decision.status,
          decision.reviewer,
          decision.note,
          decision.at,
        ],
      );
      const items = rows.map(toItem).sort((a, b) => a.id.localeCompare(b.id));
      for (const item of items) await auditDecision(tx, item.id, decision);
      return items;
    }),

  approved: (tenantId, { afterId, limit }) =>
    withTenant(sql, tenantId, async (tx) =>
      (
        await tx.query<Row>(
          `SELECT ${COLUMNS} FROM document_review
            WHERE status = ANY($3::text[]) AND id > $1
            ORDER BY id LIMIT $2`,
          [afterId, limit, APPROVAL_STATUSES],
        )
      ).map(toItem),
    ),
});
