import type { SqlClient } from '../../../platform/database/sql-client.ts';
import { withTenant } from '../../../platform/database/tenant-transaction.ts';
import type { SituationRecordReader } from '../application/index.ts';

type Row = { module: string; id: string; payload: Record<string, unknown> | string };

/**
 * Reads `module_records` (owned by the records context) under the tenant's RLS transaction,
 * so a read-only account never sees records marked 'restringido' (ADR 0012).
 */
export const createSqlSituationRecordReader = (sql: SqlClient): SituationRecordReader => ({
  read: (tenantId, modules) =>
    withTenant(sql, tenantId, async (tx) => {
      const rows = await tx.query<Row>(
        `SELECT module, id, payload FROM module_records
          WHERE tenant_id = $1 AND module = ANY($2::text[]) ORDER BY module, id`,
        [tenantId, [...modules]],
      );
      return rows.map((row) => ({
        module: row.module,
        id: row.id,
        payload: typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload,
      }));
    }),
});
