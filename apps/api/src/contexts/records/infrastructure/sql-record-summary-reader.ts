import type { SqlClient } from '../../../platform/database/sql-client.ts';
import { withTenant } from '../../../platform/database/tenant-transaction.ts';
import type { RecordSummaryReader } from '../application/ports.ts';
import type { ModuleName, Payload } from '../domain/modules.ts';

/** Same search expression as the per-type list (sql-record-store.ts), so both match alike. */
const MATCHES = `module = ANY($1::text[])
  AND ($2::text IS NULL OR strpos(lower(id || ' ' || payload::text), lower($2)) > 0)`;

/**
 * Reads module_records only through withTenant: tenant_id and clearance come from the session
 * scope under forced RLS, never from the query. One transaction keeps page and totals coherent.
 */
export const createSqlRecordSummaryReader = (sql: SqlClient): RecordSummaryReader => ({
  summary: (tenantId, modules, { limit, offset, q }) =>
    withTenant(sql, tenantId, async (tx) => {
      const rows = await tx.query<{
        module: ModuleName;
        id: string;
        payload: Payload;
        updated_at: Date | string;
      }>(
        `SELECT module, id, payload, updated_at FROM module_records WHERE ${MATCHES}
         ORDER BY array_position($1::text[], module), updated_at DESC, id DESC
         LIMIT $3 OFFSET $4`,
        [modules, q, limit, offset],
      );
      const totals = await tx.query<{ module: ModuleName; total: number | string }>(
        `SELECT module, count(*) AS total FROM module_records WHERE ${MATCHES} GROUP BY module`,
        [modules, q],
      );
      return {
        rows: rows.map((row) => ({
          module: row.module,
          id: row.id,
          payload: row.payload,
          updatedAt: new Date(row.updated_at),
        })),
        counts: new Map(totals.map((row) => [row.module, Number(row.total)])),
      };
    }),
});
