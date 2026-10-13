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

export const createSqlAuditReader = (sql: SqlClient): AuditReader => ({
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
