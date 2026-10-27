import type { SqlClient } from '../../../platform/database/sql-client.ts';
import type { TenantDataReader, TenantExportData } from '../application/ports.ts';
import { formatScope } from '../domain/scope.ts';

// Identifiers are static code, never request-controlled. New owning contexts extend explicitly.
const TABLES = {
  module_records: 'id',
  audit: 'id',
  attachments: 'id',
  document_review: 'id',
  digital_alert_reviews: 'id',
  preventive_actions: 'id',
  preventive_action_log: 'id',
  record_versions: 'id',
  record_links: 'id',
  // Automation configuration and history (ADR 0014); channels are left out because their
  // settings hold sealed third-party secrets.
  automation_rules: 'id',
  automation_runs: 'id',
  notifications: 'id',
  // Authorization and query configuration has no provider credentials and no numeric id.
  source_import_settings: 'source_id',
  // Colour meanings, thresholds and phase (ADR 0020, 0027); one row per tenant, exported as stored.
  project_settings: 'tenant_id',
} as const;

export const createSqlTenantDataReader = (sql: SqlClient): TenantDataReader => ({
  async read(scope) {
    const tenantId = formatScope(scope);
    return sql.transaction(async (tx) => {
      // Must precede any snapshot-acquiring query. Never expose a partial multi-table dump.
      await tx.exec('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
      // An administrator's export includes records marked 'restringido' (ADR 0012).
      await tx.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.clearance', 'full', true)",
        [tenantId],
      );
      await tx.exec('SET LOCAL ROLE mascli_tenant');
      const tenant = tx;
      {
        const data: { -readonly [K in keyof TenantExportData]: TenantExportData[K] } = {
          module_records: [],
          audit: [],
          attachments: [],
          document_review: [],
          digital_alert_reviews: [],
          preventive_actions: [],
          preventive_action_log: [],
          record_versions: [],
          record_links: [],
          automation_rules: [],
          automation_runs: [],
          notifications: [],
          source_import_settings: [],
          project_settings: [],
        };
        for (const table of Object.keys(TABLES) as (keyof typeof TABLES)[]) {
          const [relation] = await tenant.query<{ present: string | null; secured: boolean }>(
            `SELECT to_regclass($1)::text AS present,
               COALESCE((SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid = to_regclass($1)), false) AS secured`,
            [`public.${table}`],
          );
          if (!relation?.present) continue;
          if (!relation.secured)
            throw new Error('Export requires forced tenant row-level security');
          data[table] = await tenant.query<Record<string, unknown>>(
            `SELECT * FROM public.${table} WHERE tenant_id = $1 ORDER BY ${TABLES[table]}`,
            [tenantId],
          );
        }
        return data;
      }
    });
  },
});
