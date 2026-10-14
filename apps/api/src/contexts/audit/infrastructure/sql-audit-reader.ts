import type { SqlClient } from '../../../platform/database/sql-client.ts';
import { withTenant } from '../../../platform/database/tenant-transaction.ts';
import type { AuditReader } from '../application/index.ts';

type Row = {
  id: number;
  ts: Date | string;
  module: string;
  record_id: string | null;
  action: string;
  detail: string | null;
};

const toRecord = (row: Row) => ({
  id: row.id,
  at: new Date(row.ts),
  module: row.module,
  recordId: row.record_id,
  action: row.action,
  detail: row.detail,
});

export const createSqlAuditReader = (sql: SqlClient): AuditReader => ({
  after: (tenantId, afterId, limit) =>
    withTenant(sql, tenantId, async (tx) =>
      (
        await tx.query<Row>(
          'SELECT id, ts, module, record_id, action, detail FROM audit WHERE id > $1 ORDER BY id LIMIT $2',
          [afterId, limit],
        )
      ).map(toRecord),
    ),
  lastId: (tenantId) =>
    withTenant(sql, tenantId, async (tx) => {
      const [row] = await tx.query<{ id: number | null }>('SELECT max(id) AS id FROM audit');
      return Number(row?.id ?? 0);
    }),
  latest: (tenantId, limit) =>
    withTenant(sql, tenantId, async (tx) =>
      (
        await tx.query<Row>(
          'SELECT id, ts, module, record_id, action, detail FROM audit ORDER BY id DESC LIMIT $1',
          [limit],
        )
      ).map((row) => ({
        id: row.id,
        at: new Date(row.ts),
        module: row.module,
        recordId: row.record_id,
        action: row.action,
        detail: row.detail,
      })),
    ),
});
