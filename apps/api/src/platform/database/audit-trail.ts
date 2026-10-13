import type { SqlClient } from './sql-client.ts';

export type AuditEntry = {
  readonly module: string;
  readonly recordId: string | null;
  readonly action: string;
  readonly detail: string;
  readonly at: Date;
};

/**
 * Appends one audit row inside the caller's tenant transaction (see withTenant), so the
 * business write and its audit entry commit or roll back together. The tenant comes from
 * the transaction-local `app.tenant_id`, never from the caller.
 */
export const appendAudit = async (tx: SqlClient, entry: AuditEntry): Promise<void> => {
  await tx.query(
    `INSERT INTO audit (tenant_id, ts, module, record_id, action, detail)
     VALUES (current_setting('app.tenant_id', true), $1, $2, $3, $4, $5)`,
    [entry.at, entry.module, entry.recordId, entry.action, entry.detail],
  );
};
