import type { SqlClient } from '../../../platform/database/sql-client.ts';
import { appendAudit } from '../../../platform/database/audit-trail.ts';
import { withTenant } from '../../../platform/database/tenant-transaction.ts';
import type { IrsaConfigStore } from '../application/ports.ts';
import type { IrsaConfig } from '../domain/index.ts';
import { jsonValue } from './json-value.ts';

export const createSqlIrsaConfigStore = (sql: SqlClient): IrsaConfigStore => ({
  load: (tenantId) =>
    withTenant(sql, tenantId, async (tx) => {
      const [row] = await tx.query<{ config: unknown }>(
        'SELECT config FROM irsa_configs WHERE tenant_id = $1',
        [tenantId],
      );
      return row ? jsonValue<IrsaConfig>(row.config) : null;
    }),
  save: (tenantId, config, at, auditDetail) =>
    withTenant(sql, tenantId, async (tx) => {
      await tx.query(
        `INSERT INTO irsa_configs (tenant_id, config, updated_at) VALUES ($1, $2::json, $3)
         ON CONFLICT (tenant_id) DO UPDATE SET config = EXCLUDED.config, updated_at = EXCLUDED.updated_at`,
        [tenantId, JSON.stringify(config), at.toISOString()],
      );
      await appendAudit(tx, {
        module: 'IRSA',
        recordId: null,
        action: 'CONFIG_UPDATE',
        detail: auditDetail,
        at,
      });
    }),
});
