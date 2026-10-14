import { currentRequestContext } from '../request-context.ts';
import type { SqlClient } from './sql-client.ts';

/**
 * Runs `fn` in a transaction scoped to one tenant (docs/adr/0003):
 * - `app.tenant_id` is set transaction-locally and read by every RLS policy;
 * - the transaction drops to the non-owner role `mascli_tenant`, so policies are enforced
 *   and global tables (users, sessions, grants) are unreadable.
 * - `app.actor` names the authenticated user of the current request, read by the record
 *   history trigger (docs/adr/0011); it is empty outside a request.
 * All settings end with the transaction, which keeps pooled connections clean.
 */
export const withTenant = async <T>(
  sql: SqlClient,
  tenantId: string,
  fn: (tx: SqlClient) => Promise<T>,
): Promise<T> => {
  if (!tenantId) throw new Error('Tenant id is required');
  return sql.transaction(async (tx) => {
    await tx.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.actor', $2, true)",
      [tenantId, currentRequestContext()?.actor ?? ''],
    );
    await tx.exec('SET LOCAL ROLE mascli_tenant');
    return fn(tx);
  });
};
