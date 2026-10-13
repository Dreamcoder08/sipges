/**
 * Writes the mapped legacy data into PostgreSQL. Global tables (tenants, users, grants) are
 * written in one transaction as the owner role; every tenant's business tables are written in
 * one `withTenant` transaction, so they commit or roll back together under forced RLS.
 *
 * Keyed inserts are `ON CONFLICT DO NOTHING` on the natural key; every key that already
 * existed is returned as a skipped row so the use case reports it (a bootstrap `admin` must never
 * silently win over the legacy account). `audit` and `irsa_snapshots` have generated keys and
 * are append-only: the use case never writes into a tenant whose tables already hold rows.
 */
import type { SqlClient } from '../../../platform/database/sql-client.ts';
import { withTenant } from '../../../platform/database/tenant-transaction.ts';
import type { SecretCipher } from '../../../contexts/identity/application/index.ts';
import { TENANT_TABLES, type TableCounts, type TenantTable } from '../domain/legacy.ts';
import { rowFingerprint } from '../domain/mapping.ts';
import type {
  GlobalCounts,
  SkippedRow,
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

const date = (value: unknown): Date => new Date(value as string | Date);
const json = (value: unknown): unknown => JSON.parse(String(value));

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
      const skipped: SkippedRow[] = [];
      let tenants = 0;
      for (const tenant of batch.tenants) {
        const rows = await tx.query(
          `INSERT INTO tenants (company_id, project_id, label) VALUES ($1, $2, $3)
           ON CONFLICT DO NOTHING RETURNING tenant_id`,
          [tenant.companyId, tenant.projectId, tenant.label],
        );
        tenants += rows.length;
        if (!rows.length)
          skipped.push({ table: 'tenants', id: `${tenant.companyId}/${tenant.projectId}` });
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
        if (!rows.length) skipped.push({ table: 'users', id: user.username });
      }
      let grants = 0;
      for (const grant of batch.grants) {
        const rows = await tx.query(
          `INSERT INTO grants (username, tenant_id) VALUES ($1, $2)
           ON CONFLICT DO NOTHING RETURNING username`,
          [grant.username, grant.tenantId],
        );
        grants += rows.length;
        if (!rows.length)
          skipped.push({ table: 'grants', id: `${grant.username}@${grant.tenantId}` });
      }
      return { counts: { users, tenants, grants }, skipped };
    }),

  writeTenant: (tenantId, batch: TenantBatch) =>
    withTenant(sql, tenantId, async (tx) => {
      const counts: Record<string, number> = Object.fromEntries(
        TENANT_TABLES.map((table) => [table, 0]),
      );
      const skipped: SkippedRow[] = [];
      const bump = (table: TenantTable, rows: readonly unknown[], id?: string) => {
        counts[table] = (counts[table] ?? 0) + rows.length;
        if (id !== undefined && !rows.length) skipped.push({ table, id });
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
          `${record.module}/${record.id}`,
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
          tenantId,
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
          attachment.id,
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
          review.id,
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
          alert.id,
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
          action.id,
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
          entry.id,
        );
      }

      return { counts: counts as TableCounts, skipped };
    }),

  async identity() {
    const users = await sql.query<{
      username: string;
      full_name: string;
      password_hash: string;
      role: string;
      active: boolean;
      totp_enabled: boolean;
      totp_present: boolean;
    }>(
      `SELECT username, full_name, password_hash, role, active, totp_enabled,
         totp_secret_sealed IS NOT NULL AS totp_present FROM users`,
    );
    const tenants = await sql.query<{ company_id: string; project_id: string; label: string }>(
      'SELECT company_id, project_id, label FROM tenants',
    );
    const grants = await sql.query<{ username: string; tenant_id: string }>(
      'SELECT username, tenant_id FROM grants',
    );
    return {
      users: users.map((u) => ({
        username: u.username,
        fullName: u.full_name,
        passwordHash: u.password_hash,
        role: u.role,
        active: u.active,
        totpEnabled: u.totp_enabled,
        totpPresent: u.totp_present,
      })),
      tenants: tenants.map((t) => ({
        companyId: t.company_id,
        projectId: t.project_id,
        label: t.label,
      })),
      grants: grants.map((g) => ({ username: g.username, tenantId: g.tenant_id })),
    };
  },

  // JSON columns are read as text and numbers/timestamps normalized, so PGlite and postgres.js
  // produce the same canonical rows as the mapped source.
  rowFingerprints: (tenantId) =>
    withTenant(sql, tenantId, async (tx) => {
      const rows = (text: string) =>
        tx.query<Record<string, unknown>>(`${text} WHERE tenant_id = $1`, [tenantId]);
      const s = (value: unknown) => value as string;
      const n = (value: unknown) => (value === null ? null : (value as string));
      const out: Record<TenantTable, string[]> = {
        module_records: (
          await rows(
            'SELECT module, id, payload::text AS payload, created_at, updated_at FROM module_records',
          )
        ).map((r) =>
          rowFingerprint.module_records({
            module: s(r['module']),
            id: s(r['id']),
            payload: json(r['payload']) as Record<string, unknown>,
            createdAt: date(r['created_at']),
            updatedAt: date(r['updated_at']),
          }),
        ),
        audit: (await rows('SELECT ts, module, record_id, action, detail FROM audit')).map((r) =>
          rowFingerprint.audit({
            ts: date(r['ts']),
            module: s(r['module']),
            recordId: n(r['record_id']),
            action: s(r['action']),
            detail: n(r['detail']),
          }),
        ),
        irsa_configs: (await rows('SELECT config::text AS config FROM irsa_configs')).map((r) =>
          rowFingerprint.irsa_configs(json(r['config']) as Record<string, unknown>),
        ),
        irsa_snapshots: (
          await rows(
            'SELECT ts, irsa, level, scores::text AS scores, config_version, note FROM irsa_snapshots',
          )
        ).map((r) =>
          rowFingerprint.irsa_snapshots({
            ts: date(r['ts']),
            irsa: Number(r['irsa']),
            level: s(r['level']),
            scores: json(r['scores']),
            configVersion: n(r['config_version']),
            note: n(r['note']),
          }),
        ),
        attachments: (
          await rows(
            `SELECT id, storage_key, original_name, content_type, size_bytes::text AS size_bytes,
               sha256, linked_module, record_module, linked_record_id, document_type, author,
               verification, notes, project_id, project_name, created_at FROM attachments`,
          )
        ).map((r) =>
          rowFingerprint.attachments({
            id: s(r['id']),
            storageKey: s(r['storage_key']),
            originalName: s(r['original_name']),
            contentType: s(r['content_type']),
            sizeBytes: Number(r['size_bytes']),
            sha256: n(r['sha256']),
            linkedModule: s(r['linked_module']),
            recordModule: s(r['record_module']),
            linkedRecordId: s(r['linked_record_id']),
            documentType: s(r['document_type']),
            author: s(r['author']),
            verification: s(r['verification']),
            notes: s(r['notes']),
            projectId: s(r['project_id']),
            projectName: s(r['project_name']),
            createdAt: date(r['created_at']),
          }),
        ),
        document_review: (
          await rows(
            `SELECT id, project_id, source_file, source_sha256, location, theme, excerpt, action,
               status, reviewer, note, created_at, updated_at FROM document_review`,
          )
        ).map((r) =>
          rowFingerprint.document_review({
            id: s(r['id']),
            projectId: s(r['project_id']),
            sourceFile: s(r['source_file']),
            sourceSha256: s(r['source_sha256']),
            location: s(r['location']),
            theme: s(r['theme']),
            excerpt: s(r['excerpt']),
            action: s(r['action']),
            status: s(r['status']),
            reviewer: s(r['reviewer']),
            note: s(r['note']),
            createdAt: date(r['created_at']),
            updatedAt: date(r['updated_at']),
          }),
        ),
        digital_alert_reviews: (
          await rows(
            `SELECT id, project_id, created_at, source_url, source_type, excerpt, sha256, level,
               score, method, themes::text AS themes, signals::text AS signals,
               suggestions::text AS suggestions, semantic_active, status, analyst_note,
               reviewer_note, reviewed_at FROM digital_alert_reviews`,
          )
        ).map((r) =>
          rowFingerprint.digital_alert_reviews({
            id: s(r['id']),
            projectId: s(r['project_id']),
            createdAt: date(r['created_at']),
            sourceUrl: s(r['source_url']),
            sourceType: s(r['source_type']),
            excerpt: s(r['excerpt']),
            sha256: s(r['sha256']),
            level: s(r['level']),
            score: Number(r['score']),
            method: s(r['method']),
            themes: json(r['themes']),
            signals: json(r['signals']),
            suggestions: json(r['suggestions']),
            semanticActive: r['semantic_active'] === true,
            status: s(r['status']),
            analystNote: s(r['analyst_note']),
            reviewerNote: n(r['reviewer_note']),
            reviewedAt: r['reviewed_at'] === null ? null : date(r['reviewed_at']),
          }),
        ),
        preventive_actions: (
          await rows(
            `SELECT id, project_id, alert_id, title, responsible, due_date, description, status,
               progress, created_at, updated_at FROM preventive_actions`,
          )
        ).map((r) =>
          rowFingerprint.preventive_actions({
            id: s(r['id']),
            projectId: s(r['project_id']),
            alertId: s(r['alert_id']),
            title: s(r['title']),
            responsible: s(r['responsible']),
            dueDate: s(r['due_date']),
            description: s(r['description']),
            status: s(r['status']),
            progress: Number(r['progress']),
            createdAt: date(r['created_at']),
            updatedAt: date(r['updated_at']),
          }),
        ),
        preventive_action_log: (
          await rows(
            `SELECT id, action_id, created_at, status, progress, note, evidence_url
               FROM preventive_action_log`,
          )
        ).map((r) =>
          rowFingerprint.preventive_action_log({
            id: s(r['id']),
            actionId: s(r['action_id']),
            createdAt: date(r['created_at']),
            status: s(r['status']),
            progress: Number(r['progress']),
            note: s(r['note']),
            evidenceUrl: n(r['evidence_url']),
          }),
        ),
      };
      return out;
    }),

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
