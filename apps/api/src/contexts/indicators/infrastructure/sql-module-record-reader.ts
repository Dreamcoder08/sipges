import type { SqlClient } from '../../../platform/database/sql-client.ts';
import { withTenant } from '../../../platform/database/tenant-transaction.ts';
import type { ModuleRecordReader } from '../application/ports.ts';
import { INDICATOR_MODULES, type IndicatorModule, type RecordPayload } from '../domain/index.ts';
import { jsonValue } from './json-value.ts';

type Row = { module: IndicatorModule; id: string; payload: unknown };

const emptyRecords = () =>
  Object.fromEntries(INDICATOR_MODULES.map((m) => [m, [] as RecordPayload[]])) as Record<
    IndicatorModule,
    RecordPayload[]
  >;

const placeholders = INDICATOR_MODULES.map((_, i) => `$${i + 2}`).join(', ');

/**
 * Reads `public.module_records(tenant_id, module, id, payload jsonb)` (owned by the Records context).
 * Until that table exists, every module is empty instead of failing the request.
 */
export const createSqlModuleRecordReader = (sql: SqlClient): ModuleRecordReader => ({
  read: (tenantId) =>
    withTenant(sql, tenantId, async (tx) => {
      const records = emptyRecords();
      const [relation] = await tx.query<{ present: string | null; secured: boolean }>(
        `SELECT to_regclass('public.module_records')::text AS present,
           COALESCE((SELECT relrowsecurity AND relforcerowsecurity FROM pg_class
                     WHERE oid = to_regclass('public.module_records')), false) AS secured`,
      );
      if (!relation?.present) return records;
      if (!relation.secured)
        throw new Error('module_records requires forced tenant row-level security');
      const rows = await tx.query<Row>(
        `SELECT module, id, payload FROM public.module_records
          WHERE tenant_id = $1 AND module IN (${placeholders})
          ORDER BY module, id`,
        [tenantId, ...INDICATOR_MODULES],
      );
      for (const row of rows) {
        // app.py records_of: the payload plus `_id`, which overrides any payload key.
        records[row.module].push({
          ...jsonValue<Record<string, unknown>>(row.payload),
          _id: row.id,
        });
      }
      return records;
    }),
});
