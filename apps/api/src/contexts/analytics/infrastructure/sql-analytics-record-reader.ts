import type { SqlClient } from '../../../platform/database/sql-client.ts';
import { withTenant } from '../../../platform/database/tenant-transaction.ts';
import { type Scope, formatScope } from '../../tenancy/application/index.ts';
import type { AnalyticsRecordReader, RiskRecord } from '../application/index.ts';
import type { StoredRecord } from '../domain/records.ts';

type Row = {
  module: string;
  id: string;
  payload: Record<string, unknown>;
  updated_at: Date | string;
};

/**
 * Reads `public.module_records` (owned by the records context, T6) under the tenant's RLS
 * transaction, newest first as app.py lists them. Until that table exists every module reads as
 * empty; a table without forced row-level security is refused rather than trusted.
 */
const readRows = (sql: SqlClient, scope: Scope, modules: readonly string[]): Promise<Row[]> => {
  if (!modules.length) return Promise.resolve([]);
  const tenantId = formatScope(scope);
  return withTenant(sql, tenantId, async (tx) => {
    const [relation] = await tx.query<{ present: string | null; secured: boolean }>(
      `SELECT to_regclass('public.module_records')::text AS present,
         COALESCE((SELECT relrowsecurity AND relforcerowsecurity FROM pg_class
           WHERE oid = to_regclass('public.module_records')), false) AS secured`,
    );
    if (!relation?.present) return [];
    if (!relation.secured) throw new Error('Analytics requires forced tenant row-level security');
    return tx.query<Row>(
      `SELECT module, id, payload, updated_at FROM public.module_records
        WHERE tenant_id = $1 AND module = ANY($2::text[]) ORDER BY updated_at DESC, id`,
      [tenantId, [...modules]],
    );
  });
};

export const createSqlAnalyticsRecordReader = (sql: SqlClient): AnalyticsRecordReader => ({
  async read(scope: Scope, modules) {
    const result: Record<string, StoredRecord[]> = Object.fromEntries(modules.map((m) => [m, []]));
    for (const row of await readRows(sql, scope, modules))
      result[row.module]?.push({ id: row.id, payload: row.payload });
    return result;
  },
});

/** The same rows with their last update, which the conflict-risk back-test needs (ADR 0031 §2). */
export const createSqlDatedRecordReader = (sql: SqlClient) => ({
  async read(scope: Scope, modules: readonly string[]): Promise<RiskRecord[]> {
    return (await readRows(sql, scope, modules)).map((row) => ({
      module: row.module,
      id: row.id,
      payload: row.payload,
      updatedAt: new Date(row.updated_at).toISOString(),
    }));
  },
});
