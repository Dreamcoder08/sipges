import { appendAudit } from '../../../platform/database/audit-trail.ts';
import type { SqlClient } from '../../../platform/database/sql-client.ts';
import { withTenant } from '../../../platform/database/tenant-transaction.ts';
import type { AuditWriter } from '../application/index.ts';

/** Standalone audit entries, each in its own tenant transaction under forced RLS (ADR 0003). */
export const createSqlAuditWriter = (sql: SqlClient): AuditWriter => ({
  append: (tenantId, entry) => withTenant(sql, tenantId, (tx) => appendAudit(tx, entry)),
});
