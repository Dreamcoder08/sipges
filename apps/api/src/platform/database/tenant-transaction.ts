import type { SqlClient } from './sql-client.ts';

/**
 * Runs `fn` in a transaction scoped to one tenant (docs/adr/0003):
 * - `app.tenant_id` is set transaction-locally and read by every RLS policy;
 * - the transaction drops to the non-owner role `mascli_tenant`, so policies are enforced
 *   and global tables (users, sessions, grants) are unreadable.
 * Both settings end with the transaction, which keeps pooled connections clean.
 */
export const withTenant = async <T>(
  sql: SqlClient,
  tenantId: string,
  fn: (tx: SqlClient) => Promise<T>,
): Promise<T> => {
  if (!tenantId) throw new Error('Tenant id is required');
  return sql.transaction(async (tx) => {
    await tx.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    await tx.exec('SET LOCAL ROLE mascli_tenant');
    return fn(tx);
  });
};
