import { appendAudit } from '../../../platform/database/audit-trail.ts';
import type { SqlClient } from '../../../platform/database/sql-client.ts';
import { withTenant } from '../../../platform/database/tenant-transaction.ts';
import type { AlertState, AlertStore, TerritorialAlert } from '../application/index.ts';

type Row = {
  id: string;
  project_id: string;
  created_at: Date | string;
  source_url: string;
  source_type: string;
  excerpt: string;
  sha256: string;
  level: string;
  score: number;
  method: string;
  themes: { tema: string }[];
  signals: unknown[];
  suggestions: string[];
  semantic_active: boolean;
  status: AlertState;
  analyst_note: string;
  reviewer_note: string | null;
  reviewed_at: Date | string | null;
};

const COLUMNS = `id, project_id, created_at, source_url, source_type, excerpt, sha256, level, score,
  method, themes, signals, suggestions, semantic_active, status, analyst_note, reviewer_note,
  reviewed_at`;

const toAlert = (row: Row): TerritorialAlert => ({
  id: row.id,
  projectId: row.project_id,
  createdAt: new Date(row.created_at),
  sourceUrl: row.source_url,
  sourceType: row.source_type,
  excerpt: row.excerpt,
  sha256: row.sha256,
  level: row.level,
  score: Number(row.score),
  method: row.method,
  themes: row.themes,
  signals: row.signals,
  suggestions: row.suggestions,
  semanticActive: row.semantic_active,
  status: row.status,
  analystNote: row.analyst_note,
  reviewerNote: row.reviewer_note,
  reviewedAt: row.reviewed_at === null ? null : new Date(row.reviewed_at),
});

/** Audit module name used by app.py for the alert inbox. */
const AUDIT_MODULE = 'InteligenciaDigital';

export const createSqlAlertStore = (sql: SqlClient): AlertStore => ({
  create: (tenantId, alert) =>
    withTenant(sql, tenantId, async (tx) => {
      const [row] = await tx.query<Row>(
        `INSERT INTO digital_alert_reviews (tenant_id, id, project_id, created_at, source_url,
           source_type, excerpt, sha256, level, score, method, themes, signals, suggestions,
           semantic_active, status, analyst_note)
         VALUES (current_setting('app.tenant_id', true), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
           $11::jsonb, $12::jsonb, $13::jsonb, $14, 'Pendiente de verificación', $15)
         RETURNING ${COLUMNS}`,
        [
          alert.id,
          alert.projectId,
          alert.createdAt,
          alert.sourceUrl,
          alert.sourceType,
          alert.excerpt,
          alert.sha256,
          alert.level,
          alert.score,
          alert.method,
          JSON.stringify(alert.themes),
          JSON.stringify(alert.signals),
          JSON.stringify(alert.suggestions),
          alert.semanticActive,
          alert.analystNote,
        ],
      );
      await appendAudit(tx, {
        module: AUDIT_MODULE,
        recordId: alert.id,
        action: 'CREATE',
        detail: 'Señal registrada; IRSA intacto',
        at: alert.createdAt,
      });
      if (!row) throw new Error('Alert insert returned no row');
      return toAlert(row);
    }),

  list: (tenantId, { projectId, limit }) =>
    withTenant(sql, tenantId, async (tx) =>
      (
        await tx.query<Row>(
          `SELECT ${COLUMNS} FROM digital_alert_reviews WHERE project_id = $1
            ORDER BY created_at DESC, id DESC LIMIT $2`,
          [projectId, limit],
        )
      ).map(toAlert),
    ),

  get: (tenantId, id) =>
    withTenant(sql, tenantId, async (tx) => {
      const [row] = await tx.query<Row>(
        `SELECT ${COLUMNS} FROM digital_alert_reviews WHERE id = $1`,
        [id],
      );
      return row ? toAlert(row) : null;
    }),

  decide: (tenantId, { id, status, note, at }) =>
    withTenant(sql, tenantId, async (tx) => {
      const updated = await tx.query<{ id: string }>(
        `UPDATE digital_alert_reviews SET status = $2, reviewer_note = $3, reviewed_at = $4
          WHERE id = $1 RETURNING id`,
        [id, status, note, at],
      );
      if (updated.length === 0) return false;
      await appendAudit(tx, {
        module: AUDIT_MODULE,
        recordId: id,
        action: 'REVIEW',
        detail: status,
        at,
      });
      return true;
    }),
});
