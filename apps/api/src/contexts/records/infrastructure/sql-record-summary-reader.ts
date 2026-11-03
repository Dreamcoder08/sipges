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
      // One statement for the page and the totals: each query is a round trip to the database.
      const [result] = await tx.query<{
        rows: { module: ModuleName; id: string; payload: Payload; updated_at: string }[];
        totals: Record<string, number | string>;
      }>(
        `SELECT
           (SELECT coalesce(json_agg(page ORDER BY page.position, page.updated_at DESC, page.id DESC),
                            '[]'::json)
            FROM (SELECT module, id, payload, updated_at,
                         array_position($1::text[], module) AS position
                  FROM module_records WHERE ${MATCHES}
                  ORDER BY position, updated_at DESC, id DESC
                  LIMIT $3 OFFSET $4) page) AS rows,
           (SELECT coalesce(json_object_agg(module, total), '{}'::json)
            FROM (SELECT module, count(*) AS total FROM module_records WHERE ${MATCHES}
                  GROUP BY module) totals) AS totals`,
        [modules, q, limit, offset],
      );
      return {
        rows: (result?.rows ?? []).map((row) => ({
          module: row.module,
          id: row.id,
          payload: row.payload,
          updatedAt: new Date(row.updated_at),
        })),
        counts: new Map(
          Object.entries(result?.totals ?? {}).map(([module, total]) => [
            module as ModuleName,
            Number(total),
          ]),
        ),
      };
    }),
});
