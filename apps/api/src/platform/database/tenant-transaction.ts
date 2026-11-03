import { currentRequestContext } from '../request-context.ts';
import type { SqlClient } from './sql-client.ts';

/**
 * Runs `fn` in a transaction scoped to one tenant (docs/adr/0003):
 * - `app.tenant_id` is set transaction-locally and read by every RLS policy;
 * - the transaction drops to the non-owner role `sipges_tenant`, so policies are enforced
 *   and global tables (users, sessions, grants) are unreadable.
 * - `app.actor` names the authenticated user of the current request, read by the record
 *   history trigger (docs/adr/0011); it is empty outside a request.
 * - `app.clearance` is 'full' unless the request's role has limited clearance (ADR 0012);
 *   work outside a request (bootstrap, tools) runs with full clearance.
 * All settings end with the transaction, which keeps pooled connections clean.
 */
export const withTenant = async <T>(
  sql: SqlClient,
  tenantId: string,
  fn: (tx: SqlClient) => Promise<T>,
): Promise<T> => {
  // Built before the transaction: an invalid tenant id fails here and no work runs at all.
  const statement = tenantStatement(tenantId);
  return sql.transaction(async (tx) => {
    // Not awaited before the work starts: statements on one connection run in order, so the
    // work's first query is sent right behind the tenant settings and runs under them, saving
    // a round trip on every tenant request. If entering fails, PostgreSQL rejects every later
    // statement of the transaction (25P02). Both are awaited to the end, so the transaction
    // never settles while the work still runs, and a failure to enter is the error reported.
    const entered = tx.exec(statement);
    // An async wrapper turns a synchronous throw from fn into a rejection, so both are awaited.
    const work = (async () => fn(tx))();
    const [enteredResult, workResult] = await Promise.allSettled([entered, work]);
    if (enteredResult.status === 'rejected') throw enteredResult.reason;
    if (workResult.status === 'rejected') throw workResult.reason;
    return workResult.value;
  });
};

/**
 * Scopes an already open transaction to one tenant, with the same settings and role as
 * withTenant. For owner-side work (global tables) that must commit together with a tenant
 * write such as its audit row: run the global statements first, because the role switch
 * makes global tables unreadable for the rest of the transaction.
 */
export const enterTenant = async (tx: SqlClient, tenantId: string): Promise<void> => {
  await tx.exec(tenantStatement(tenantId));
};

/**
 * One statement for the tenant settings and role: this runs on every tenant request against a
 * remote database. A parameterized query costs two round trips with postgres.js
 * (parse/describe, then bind/execute), so the values are inlined as literals and run with the
 * simple protocol. `set_config('role', …, true)` is `SET LOCAL ROLE`, so the role switch rides
 * in the same statement.
 */
const tenantStatement = (tenantId: string): string => {
  if (!tenantId) throw new Error('Tenant id is required');
  const context = currentRequestContext();
  return `SELECT set_config('app.tenant_id', ${literal(tenantId)}, true),
            set_config('app.actor', ${literal(context?.actor ?? '')}, true),
            set_config('app.clearance', ${literal(context?.clearance ?? 'full')}, true),
            set_config('role', 'sipges_tenant', true)`;
};

/**
 * An escape-string literal (`E'…'`): backslashes and quotes are doubled, so the value stays one
 * literal whatever `standard_conforming_strings` is. NUL cannot be stored in text at all.
 * Safe only with an ASCII-safe client encoding; both drivers here always use UTF8.
 */
const literal = (value: string): string => {
  if (value.includes('\0')) throw new Error('Tenant settings cannot contain NUL characters');
  return `E'${value.replaceAll('\\', '\\\\').replaceAll("'", "''")}'`;
};
