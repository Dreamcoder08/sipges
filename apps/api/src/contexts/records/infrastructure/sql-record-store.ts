import { appendAudit } from '../../../platform/database/audit-trail.ts';
import type { SqlClient } from '../../../platform/database/sql-client.ts';
import { withTenant } from '../../../platform/database/tenant-transaction.ts';
import type { Payload } from '../domain/modules.ts';
import type { RecordStore, StoredRecord, StoredVersion } from '../application/ports.ts';

type Row = { id: string; payload: Payload; updated_at: Date | string };

const toRecord = (row: Row): StoredRecord => ({
  id: row.id,
  payload: row.payload,
  updatedAt: new Date(row.updated_at),
});

/**
 * Records live in module_records under forced RLS. Each change and its audit entry share one
 * withTenant transaction, so an audit row exists exactly when the change committed.
 */
export const createSqlRecordStore = (sql: SqlClient): RecordStore => ({
  list: (tenantId, module, { limit, q }) =>
    withTenant(sql, tenantId, async (tx) =>
      (
        await tx.query<Row>(
          `SELECT id, payload, updated_at FROM module_records
           WHERE module = $1 AND ($2::text IS NULL OR strpos(lower(id || ' ' || payload::text), lower($2)) > 0)
           ORDER BY updated_at DESC, id DESC LIMIT $3`,
          [module, q, limit],
        )
      ).map(toRecord),
    ),

  get: (tenantId, module, id) =>
    withTenant(sql, tenantId, async (tx) => {
      const [row] = await tx.query<Row>(
        'SELECT id, payload, updated_at FROM module_records WHERE module = $1 AND id = $2',
        [module, id],
      );
      return row ? toRecord(row) : null;
    }),

  history: (tenantId, module, id) =>
    withTenant(sql, tenantId, async (tx) =>
      (
        await tx.query<{
          operation: StoredVersion['operation'];
          payload: Payload | null;
          actor: string;
          at: Date | string;
        }>(
          `SELECT operation, payload, actor, at FROM record_versions
           WHERE module = $1 AND record_id = $2 ORDER BY id`,
          [module, id],
        )
      ).map((row) => ({ ...row, at: new Date(row.at) })),
    ),

  create: (tenantId, module, candidates, payloadFor, note, at) =>
    withTenant(sql, tenantId, async (tx) => {
      for (const id of candidates) {
        const inserted = await tx.query(
          `INSERT INTO module_records (tenant_id, module, id, payload, created_at, updated_at)
           VALUES (current_setting('app.tenant_id', true), $1, $2, $3::jsonb, $4, $4)
           ON CONFLICT DO NOTHING RETURNING id`,
          [module, id, JSON.stringify(payloadFor(id)), at],
        );
        if (inserted.length === 0) continue;
        await appendAudit(tx, { module, recordId: id, ...note, at });
        return id;
      }
      return null;
    }),

  replace: (tenantId, module, id, payload, note, at) =>
    withTenant(sql, tenantId, async (tx) => {
      const updated = await tx.query(
        `UPDATE module_records SET payload = $3::jsonb, updated_at = $4
         WHERE module = $1 AND id = $2 RETURNING id`,
        [module, id, JSON.stringify(payload), at],
      );
      if (updated.length === 0) return false;
      await appendAudit(tx, { module, recordId: id, ...note, at });
      return true;
    }),

  existing: (tenantId, module, ids) =>
    withTenant(
      sql,
      tenantId,
      async (tx) =>
        new Set(
          (
            await tx.query<{ id: string }>(
              'SELECT id FROM module_records WHERE module = $1 AND id = ANY($2::text[])',
              [module, ids],
            )
          ).map((row) => row.id),
        ),
    ),

  importBatch: (tenantId, module, items, note, at) =>
    withTenant(sql, tenantId, async (tx) => {
      let created = 0;
      let updated = 0;
      for (const item of items) {
        const [row] = await tx.query<{ inserted: boolean }>(
          `INSERT INTO module_records (tenant_id, module, id, payload, created_at, updated_at)
           VALUES (current_setting('app.tenant_id', true), $1, $2, $3::jsonb, $4, $4)
           ON CONFLICT (tenant_id, module, id) DO UPDATE
             SET payload = module_records.payload || EXCLUDED.payload, updated_at = EXCLUDED.updated_at
           RETURNING (xmax = 0) AS inserted`,
          [module, item.id, JSON.stringify(item.payload), at],
        );
        if (row?.inserted) created++;
        else updated++;
      }
      await appendAudit(tx, { module, recordId: null, ...note, at });
      return { created, updated };
    }),

  remove: (tenantId, module, id, note, at) =>
    withTenant(sql, tenantId, async (tx) => {
      const deleted = await tx.query(
        'DELETE FROM module_records WHERE module = $1 AND id = $2 RETURNING id',
        [module, id],
      );
      if (deleted.length === 0) return false;
      await appendAudit(tx, { module, recordId: id, ...note, at });
      return true;
    }),
});
