import { appendAudit } from '../../../platform/database/audit-trail.ts';
import type { SqlClient } from '../../../platform/database/sql-client.ts';
import { withTenant } from '../../../platform/database/tenant-transaction.ts';
import type { ProjectSettings, ProjectSettingsStore } from '../application/index.ts';

type Stored = Omit<ProjectSettings, 'updatedBy' | 'updatedAt'>;
type Row = { settings: Stored | string; updated_by: string; updated_at: Date | string };

export const createSqlProjectSettingsStore = (sql: SqlClient): ProjectSettingsStore => ({
  load: (tenantId) =>
    withTenant(sql, tenantId, async (tx) => {
      const [row] = await tx.query<Row>(
        'SELECT settings, updated_by, updated_at FROM project_settings WHERE tenant_id = $1',
        [tenantId],
      );
      if (!row) return null;
      const settings = typeof row.settings === 'string' ? JSON.parse(row.settings) : row.settings;
      return { ...settings, updatedBy: row.updated_by, updatedAt: new Date(row.updated_at) };
    }),
  save: (tenantId, settings, auditDetail) =>
    withTenant(sql, tenantId, async (tx) => {
      const { updatedBy, updatedAt, ...stored } = settings;
      const at = updatedAt ?? new Date();
      await tx.query(
        `INSERT INTO project_settings (tenant_id, settings, updated_by, updated_at)
         VALUES ($1, $2::jsonb, $3, $4)
         ON CONFLICT (tenant_id) DO UPDATE SET settings = EXCLUDED.settings,
           updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at`,
        [tenantId, JSON.stringify(stored), updatedBy, at.toISOString()],
      );
      await appendAudit(tx, {
        module: 'SIPGES',
        recordId: null,
        action: 'CONFIG_UPDATE',
        detail: auditDetail,
        at,
      });
    }),
});
