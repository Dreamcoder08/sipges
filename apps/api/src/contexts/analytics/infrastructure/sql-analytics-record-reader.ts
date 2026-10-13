import type { SqlClient } from '../../../platform/database/sql-client.ts';
import { withTenant } from '../../../platform/database/tenant-transaction.ts';
import { type Scope, formatScope } from '../../tenancy/application/index.ts';
import type { AnalyticsRecordReader } from '../application/index.ts';
import type { StoredRecord } from '../domain/records.ts';

type Row = { module: string; id: string; payload: Record<string, unknown> };

/**
 * Reads `public.module_records` (owned by the records context, T6) under the tenant's RLS
 * transaction. Until that table exists every module reads as empty; a table without forced
 * row-level security is refused rather than trusted.
 */
export const createSqlAnalyticsRecordReader = (sql: SqlClient): AnalyticsRecordReader => ({
  async read(scope: Scope, modules) {
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
      // app.py lists records newest first.
      const rows = await tx.query<Row>(
        `SELECT module, id, payload FROM public.module_records
          WHERE tenant_id = $1 AND module = ANY($2::text[]) ORDER BY updated_at DESC, id`,
        [tenantId, [...modules]],
      );
      for (const row of rows) result[row.module]?.push({ id: row.id, payload: row.payload });
      return result;
    });
  },
});
