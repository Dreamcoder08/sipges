import type { SqlClient } from '../../../platform/database/sql-client.ts';
import type { TenantDataReader, TenantExportData } from '../application/ports.ts';
import { formatScope } from '../domain/scope.ts';

// Identifiers are static code, never request-controlled. New owning contexts extend explicitly.
const TABLES = ['module_records', 'audit', 'attachments'] as const;

export const createSqlTenantDataReader = (sql: SqlClient): TenantDataReader => ({
  async read(scope) {
    const tenantId = formatScope(scope);
    return sql.transaction(async (tx) => {
      // Must precede any snapshot-acquiring query. Never expose a partial multi-table dump.
      await tx.exec('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
      await tx.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
      await tx.exec('SET LOCAL ROLE mascli_tenant');
      const tenant = tx;
      {
        const data: { -readonly [K in keyof TenantExportData]: TenantExportData[K] } = {
          module_records: [],
          audit: [],
          attachments: [],
        };
        for (const table of TABLES) {
          const [relation] = await tenant.query<{ present: string | null; secured: boolean }>(
            `SELECT to_regclass($1)::text AS present,
               COALESCE((SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid = to_regclass($1)), false) AS secured`,
            [`public.${table}`],
          );
          if (!relation?.present) continue;
          if (!relation.secured)
            throw new Error('Export requires forced tenant row-level security');
          data[table] = await tenant.query<Record<string, unknown>>(
            `SELECT * FROM public.${table} WHERE tenant_id = $1 ORDER BY id`,
            [tenantId],
          );
        }
        return data;
      }
    });
  },
});
