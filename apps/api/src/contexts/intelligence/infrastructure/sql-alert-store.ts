import { createHash } from 'node:crypto';
import type { SqlClient } from '../../../platform/database/sql-client.ts';
import { withTenant } from '../../../platform/database/tenant-transaction.ts';
import type { AlertState, AlertStore, TerritorialAlert } from '../application/index.ts';

type Row = {
  id: string;
  project_id: string;
  created_at: Date | string;
  source_url: string;
  source_type: string;
  territory: string | null;
  source_record: { module: 'Narrativas'; id: string } | null;
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
  first_validator: string | null;
};

const COLUMNS = `id, project_id, created_at, source_url, source_type, excerpt, sha256, level, score,
  method, themes, signals, suggestions, semantic_active, status, analyst_note, reviewer_note,
  reviewed_at, territory, source_record, first_validator`;

const toAlert = (row: Row): TerritorialAlert => ({
  id: row.id,
  projectId: row.project_id,
  createdAt: new Date(row.created_at),
  sourceUrl: row.source_url,
  sourceType: row.source_type,
  territory: row.territory,
  sourceRecord: row.source_record,
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
  firstValidator: row.first_validator,
});

/** Audit module name used by app.py for the alert inbox. */
const AUDIT_MODULE = 'InteligenciaDigital';

/** Immutable event-time fields: automation must not join a later mutable review. */
const snapshot = (row: Row) => ({
  id: row.id,
  project_id: row.project_id,
  level: row.level,
  status: row.status,
  score: Number(row.score),
  territory: row.territory,
  source_url: row.source_url,
  source_type: row.source_type,
  source_record: row.source_record,
  sha256: row.sha256,
});
const auditSnapshot = async (tx: SqlClient, row: Row, action: string, detail: string, at: Date) => {
  await tx.query(
    `INSERT INTO audit (tenant_id, ts, module, record_id, action, detail, event_payload)
     VALUES (current_setting('app.tenant_id', true), $1, $2, $3, $4, $5, $6::jsonb)`,
    [at, AUDIT_MODULE, row.id, action, detail, JSON.stringify(snapshot(row))],
  );
};

export const createSqlAlertStore = (sql: SqlClient): AlertStore => ({
  create: (tenantId, alert) =>
    withTenant(sql, tenantId, async (tx) => {
      const territory = alert.territory ?? null;
      const sourceRecord = alert.sourceRecord ?? null;
      const key = createHash('sha256')
        .update(
          JSON.stringify([
            alert.sha256,
            alert.sourceUrl,
            alert.sourceType,
            territory,
            sourceRecord?.module ?? null,
            sourceRecord?.id ?? null,
          ]),
        )
        .digest('hex');
      await tx.query(
        `INSERT INTO digital_signal_dedup_locks (tenant_id, dedup_key)
         VALUES (current_setting('app.tenant_id', true), $1) ON CONFLICT DO NOTHING`,
        [key],
      );
      await tx.query(
        `SELECT dedup_key FROM digital_signal_dedup_locks WHERE dedup_key = $1 FOR UPDATE`,
        [key],
      );
      const [existing] = await tx.query<Row>(
        `SELECT ${COLUMNS} FROM digital_alert_reviews
         WHERE sha256 = $1 AND source_url = $2 AND source_type = $3
           AND territory IS NOT DISTINCT FROM $4 AND source_record IS NOT DISTINCT FROM $5::jsonb
           AND created_at >= $6
         ORDER BY created_at DESC, id DESC LIMIT 1`,
        [
          alert.sha256,
          alert.sourceUrl,
          alert.sourceType,
          territory,
          sourceRecord === null ? null : JSON.stringify(sourceRecord),
          new Date(alert.createdAt.getTime() - 24 * 60 * 60 * 1000),
        ],
      );
      if (existing) return { ...toAlert(existing), duplicate: true };
      const [row] = await tx.query<Row>(
        `INSERT INTO digital_alert_reviews (tenant_id, id, project_id, created_at, source_url,
           source_type, excerpt, sha256, level, score, method, themes, signals, suggestions,
           semantic_active, status, analyst_note, territory, source_record)
         VALUES (current_setting('app.tenant_id', true), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
           $11::jsonb, $12::jsonb, $13::jsonb, $14, 'Pendiente de verificación', $15, $16, $17::jsonb)
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
          territory,
          sourceRecord === null ? null : JSON.stringify(sourceRecord),
        ],
      );
      if (!row) throw new Error('Alert insert returned no row');
      await auditSnapshot(tx, row, 'CREATE', 'Señal registrada; IRSA intacto', alert.createdAt);
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
      const [updated] = await tx.query<Row>(
        `UPDATE digital_alert_reviews SET status = $2, reviewer_note = $3, reviewed_at = $4,
           first_validator = CASE WHEN $2 IN ('Corroborado', 'En seguimiento')
             THEN first_validator END
          WHERE id = $1 RETURNING ${COLUMNS}`,
        [id, status, note, at],
      );
      if (!updated) return false;
      const detail = updated.first_validator
        ? `${status} (primera validación: ${updated.first_validator})`
        : status;
      await auditSnapshot(tx, updated, 'REVIEW', detail, at);
      return true;
    }),

  recordFirstValidation: (tenantId, { id, actor, note, at }) =>
    withTenant(sql, tenantId, async (tx) => {
      const [updated] = await tx.query<Row>(
        `UPDATE digital_alert_reviews SET first_validator = $2, first_validated_at = $3,
           reviewer_note = $4
          WHERE id = $1 RETURNING ${COLUMNS}`,
        [id, actor, at, note],
      );
      if (!updated) return false;
      await auditSnapshot(tx, updated, 'REVIEW', `Primera validación: ${actor}`, at);
      return true;
    }),
});
