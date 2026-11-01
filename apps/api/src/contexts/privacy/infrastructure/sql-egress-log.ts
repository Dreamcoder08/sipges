import { appendAudit } from '../../../platform/database/audit-trail.ts';
import type { SqlClient } from '../../../platform/database/sql-client.ts';
import { withTenant } from '../../../platform/database/tenant-transaction.ts';
import type { EgressLog } from '../application/index.ts';

/** Module and action under which every egress shows in Auditoría. */
export const EGRESS_AUDIT_MODULE = 'IA externa';
export const EGRESS_AUDIT_ACTION = 'EGRESS';

/** The append-only audit trail of the project: one row per release, no payload values. */
export const createSqlEgressLog = (sql: SqlClient): EgressLog => ({
  append: (tenantId, entry) =>
    withTenant(sql, tenantId, (tx) =>
      appendAudit(tx, {
        module: EGRESS_AUDIT_MODULE,
        recordId: null,
        action: EGRESS_AUDIT_ACTION,
        detail: entry.detail,
        at: entry.at,
      }),
    ),
});
