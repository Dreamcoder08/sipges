import type { SqlClient } from '../../../platform/database/sql-client.ts';
import { withTenant } from '../../../platform/database/tenant-transaction.ts';
import { formatScope } from '../../tenancy/application/index.ts';
import type { AnalyticsRecordReader } from '../application/index.ts';
import type { StoredRecord } from '../domain/records.ts';

type Row = { module: string; id: string; payload: Record<string, unknown> };

/** Dashboard-only input; sibling analytics still require the complete stored payload. */
export const createSqlDashboardRecordReader = (sql: SqlClient): AnalyticsRecordReader => ({
  async read(scope, modules) {
    const tenantId = formatScope(scope);
    const result: Record<string, StoredRecord[]> = Object.fromEntries(modules.map((m) => [m, []]));
    if (!modules.length) return result;
    return withTenant(sql, tenantId, async (tx) => {
      const [relation] = await tx.query<{ present: string | null; secured: boolean }>(
        `SELECT to_regclass('public.module_records')::text AS present,
           COALESCE((SELECT relrowsecurity AND relforcerowsecurity FROM pg_class
             WHERE oid = to_regclass('public.module_records')), false) AS secured`,
      );
      if (!relation?.present) return result;
      if (!relation.secured) throw new Error('Analytics requires forced tenant row-level security');
      // Keep JSON values (not ->> text): Python truthiness/coercion belongs to the engine.
      // Missing keys become null, equivalent for dashboard's status and level fallbacks.
      // RLS still evaluates the original row, including its classification marking.
      const rows = await tx.query<Row>(
        `SELECT module, id,
           CASE module
             WHEN 'Demandas' THEN jsonb_build_object('Estado', payload->'Estado')
             WHEN 'Alertas' THEN jsonb_build_object(
               'Estado', payload->'Estado',
               'Nivel_Preliminar', payload->'Nivel_Preliminar', 'Nivel', payload->'Nivel')
             ELSE '{}'::jsonb
           END AS payload
         FROM public.module_records
         WHERE tenant_id = $1 AND module = ANY($2::text[]) ORDER BY updated_at DESC, id`,
        [tenantId, [...modules]],
      );
      for (const row of rows) result[row.module]?.push({ id: row.id, payload: row.payload });
      return result;
    });
  },
});
