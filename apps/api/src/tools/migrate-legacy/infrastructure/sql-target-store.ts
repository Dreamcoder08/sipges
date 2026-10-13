/**
 * Writes the mapped legacy data into PostgreSQL. Global tables (tenants, users, grants) are
 * written in one transaction as the owner role; every tenant's business tables are written in
 * one `withTenant` transaction, so they commit or roll back together under forced RLS.
 *
 * All inserts are `ON CONFLICT DO NOTHING` on the natural key, so a partially applied run can
 * be repeated. `audit` has a generated key and is therefore append-only: re-running a tenant
 * is refused by the emptiness guard unless the operator explicitly allows it.
 */
import type { SqlClient } from '../../../platform/database/sql-client.ts';
import { withTenant } from '../../../platform/database/tenant-transaction.ts';
import type { SecretCipher } from '../../../contexts/identity/application/index.ts';
import { TENANT_TABLES, type TableCounts } from '../domain/legacy.ts';
import { recordFingerprint } from '../domain/mapping.ts';
import type {
  GlobalCounts,
  TargetAttachmentDigest,
  TargetStore,
  TenantBatch,
} from '../application/ports.ts';

const countRows = async (sql: SqlClient, table: string, where: string, params: unknown[]) => {
  const [row] = await sql.query<{ n: string | number }>(
    `SELECT count(*) AS n FROM ${table} WHERE ${where}`,
    params,
  );
  return Number(row?.n ?? 0);
};

export const createSqlTargetStore = (sql: SqlClient, cipher: SecretCipher): TargetStore => ({
  async globalCounts(): Promise<GlobalCounts> {
    const one = async (table: string) => {
      const [row] = await sql.query<{ n: string | number }>(`SELECT count(*) AS n FROM ${table}`);
      return Number(row?.n ?? 0);
    };
    return {
      users: await one('users'),
      tenants: await one('tenants'),
      grants: await one('grants'),
    };
  },

  tenantCounts: (tenantId) =>
    withTenant(sql, tenantId, async (tx) => {
      const counts: Record<string, number> = {};
      for (const table of TENANT_TABLES) {
        counts[table] = await countRows(tx, table, 'tenant_id = $1', [tenantId]);
      }
      return counts as TableCounts;
    }),

  writeGlobal: (batch) =>
    sql.transaction(async (tx) => {
      let tenants = 0;
      for (const tenant of batch.tenants) {
        const rows = await tx.query(
          `INSERT INTO tenants (company_id, project_id, label) VALUES ($1, $2, $3)
           ON CONFLICT DO NOTHING RETURNING tenant_id`,
          [tenant.companyId, tenant.projectId, tenant.label],
        );
        tenants += rows.length;
      }
      let users = 0;
      for (const user of batch.users) {
        // Password hashes stay in their legacy PBKDF2 form: the identity context verifies
        // them and rehashes to Argon2id on the next successful login (docs/adr/0004).
        const rows = await tx.query(
          `INSERT INTO users (username, full_name, password_hash, role, active, created_at,
             totp_secret_sealed, totp_enabled)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (username) DO NOTHING RETURNING username`,
          [
            user.username,
            user.fullName,
            user.passwordHash,
            user.role,
            user.active,
            user.createdAt.toISOString(),
            user.totpSecret === null ? null : cipher.seal(user.totpSecret),
            user.totpEnabled && user.totpSecret !== null,
          ],
        );
        users += rows.length;
      }
      let grants = 0;
      for (const grant of batch.grants) {
        const rows = await tx.query(
          `INSERT INTO grants (username, tenant_id) VALUES ($1, $2)
           ON CONFLICT DO NOTHING RETURNING username`,
          [grant.username, grant.tenantId],
        );
        grants += rows.length;
      }
      return { users, tenants, grants };
    }),

  writeTenant: (tenantId, batch: TenantBatch) =>
    withTenant(sql, tenantId, async (tx) => {
      const counts: Record<string, number> = Object.fromEntries(
        TENANT_TABLES.map((table) => [table, 0]),
      );
      const bump = (table: string, rows: readonly unknown[]) => {
        counts[table] = (counts[table] ?? 0) + rows.length;
      };

      for (const record of batch.records) {
        bump(
          'module_records',
          await tx.query(
            `INSERT INTO module_records (tenant_id, module, id, payload, created_at, updated_at)
             VALUES (current_setting('app.tenant_id', true), $1, $2, $3::jsonb, $4, $5)
             ON CONFLICT DO NOTHING RETURNING id`,
            [
              record.module,
              record.id,
              JSON.stringify(record.payload),
              record.createdAt.toISOString(),
              record.updatedAt.toISOString(),
            ],
          ),
        );
      }

      for (const entry of batch.audit) {
        bump(
          'audit',
          await tx.query(
            `INSERT INTO audit (tenant_id, ts, module, record_id, action, detail)
             VALUES (current_setting('app.tenant_id', true), $1, $2, $3, $4, $5) RETURNING id`,
            [entry.ts.toISOString(), entry.module, entry.recordId, entry.action, entry.detail],
          ),
        );
      }

      if (batch.irsaConfig) {
        bump(
          'irsa_configs',
          await tx.query(
            `INSERT INTO irsa_configs (tenant_id, config) VALUES ($1, $2::json)
             ON CONFLICT (tenant_id) DO NOTHING RETURNING tenant_id`,
            [tenantId, JSON.stringify(batch.irsaConfig)],
          ),
        );
      }

      // Snapshot ids are generated: legacy ids are per-file and would collide across tenants.
      // Rows are inserted in legacy id order, so the history keeps its sequence.
      for (const snapshot of batch.snapshots) {
        bump(
          'irsa_snapshots',
          await tx.query(
            `INSERT INTO irsa_snapshots (tenant_id, ts, irsa, level, scores, config_version, note)
             VALUES ($1, $2, $3, $4, $5::json, $6, $7) RETURNING id`,
            [
              tenantId,
              snapshot.ts.toISOString(),
              snapshot.irsa,
              snapshot.level,
              JSON.stringify(snapshot.scores),
              snapshot.configVersion,
              snapshot.note,
            ],
          ),
        );
      }

      for (const attachment of batch.attachments) {
        bump(
          'attachments',
          await tx.query(
            `INSERT INTO attachments (tenant_id, id, storage_key, original_name, content_type,
               size_bytes, sha256, linked_module, record_module, linked_record_id, document_type,
               author, verification, notes, project_id, project_name, created_at)
             VALUES (current_setting('app.tenant_id', true), $1, $2, $3, $4, $5, $6, $7, $8, $9,
               $10, $11, $12, $13, $14, $15, $16)
             ON CONFLICT DO NOTHING RETURNING id`,
            [
              attachment.id,
              attachment.storageKey,
              attachment.originalName,
              attachment.contentType,
              attachment.sizeBytes,
              attachment.sha256,
              attachment.linkedModule,
              attachment.recordModule,
              attachment.linkedRecordId,
              attachment.documentType,
              attachment.author,
              attachment.verification,
              attachment.notes,
              attachment.projectId,
              attachment.projectName,
              attachment.createdAt.toISOString(),
            ],
          ),
        );
      }

      for (const review of batch.documentReviews) {
        bump(
          'document_review',
          await tx.query(
            `INSERT INTO document_review (tenant_id, id, project_id, source_file, source_sha256,
               location, theme, excerpt, action, status, reviewer, note, created_at, updated_at)
             VALUES (current_setting('app.tenant_id', true), $1, $2, $3, $4, $5, $6, $7, $8, $9,
               $10, $11, $12, $13)
             ON CONFLICT DO NOTHING RETURNING id`,
            [
              review.id,
              review.projectId,
              review.sourceFile,
              review.sourceSha256,
              review.location,
              review.theme,
              review.excerpt,
              review.action,
              review.status,
              review.reviewer,
              review.note,
              review.createdAt.toISOString(),
              review.updatedAt.toISOString(),
            ],
          ),
        );
      }

      for (const alert of batch.alerts) {
        bump(
          'digital_alert_reviews',
          await tx.query(
            `INSERT INTO digital_alert_reviews (tenant_id, id, project_id, created_at, source_url,
               source_type, excerpt, sha256, level, score, method, themes, signals, suggestions,
               semantic_active, status, analyst_note, reviewer_note, reviewed_at)
             VALUES (current_setting('app.tenant_id', true), $1, $2, $3, $4, $5, $6, $7, $8, $9,
               $10, $11::jsonb, $12::jsonb, $13::jsonb, $14, $15, $16, $17, $18)
             ON CONFLICT DO NOTHING RETURNING id`,
            [
              alert.id,
              alert.projectId,
              alert.createdAt.toISOString(),
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
              alert.status,
              alert.analystNote,
              alert.reviewerNote,
              alert.reviewedAt === null ? null : alert.reviewedAt.toISOString(),
            ],
          ),
        );
      }

      for (const action of batch.actions) {
        bump(
          'preventive_actions',
          await tx.query(
            `INSERT INTO preventive_actions (tenant_id, id, project_id, alert_id, title,
               responsible, due_date, description, status, progress, created_at, updated_at)
             VALUES (current_setting('app.tenant_id', true), $1, $2, $3, $4, $5, $6, $7, $8, $9,
               $10, $11)
             ON CONFLICT DO NOTHING RETURNING id`,
            [
              action.id,
              action.projectId,
              action.alertId,
              action.title,
              action.responsible,
              action.dueDate,
              action.description,
              action.status,
              action.progress,
              action.createdAt.toISOString(),
              action.updatedAt.toISOString(),
            ],
          ),
        );
      }

      for (const entry of batch.actionLog) {
        bump(
          'preventive_action_log',
          await tx.query(
            `INSERT INTO preventive_action_log (tenant_id, id, action_id, created_at, status,
               progress, note, evidence_url)
             VALUES (current_setting('app.tenant_id', true), $1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT DO NOTHING RETURNING id`,
            [
              entry.id,
              entry.actionId,
              entry.createdAt.toISOString(),
              entry.status,
              entry.progress,
              entry.note,
              entry.evidenceUrl,
            ],
          ),
        );
      }

      return counts as TableCounts;
    }),

  recordFingerprints: (tenantId) =>
    withTenant(sql, tenantId, async (tx) =>
      (
        await tx.query<{ module: string; id: string; payload: unknown }>(
          'SELECT module, id, payload FROM module_records WHERE tenant_id = $1',
          [tenantId],
        )
      ).map((row) =>
        recordFingerprint(
          row.module,
          row.id,
          typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload,
        ),
      ),
    ),

  attachmentDigests: (tenantId) =>
    withTenant(sql, tenantId, async (tx) =>
      (
        await tx.query<{ id: string; sha256: string; storage_key: string }>(
          'SELECT id, sha256, storage_key FROM attachments WHERE tenant_id = $1',
          [tenantId],
        )
      ).map((row): TargetAttachmentDigest => ({
        id: row.id,
        sha256: row.sha256,
        storageKey: row.storage_key,
      })),
    ),
});
