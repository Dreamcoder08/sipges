import { appendAudit } from '../../../platform/database/audit-trail.ts';
import type { SqlClient } from '../../../platform/database/sql-client.ts';
import { enterTenant } from '../../../platform/database/tenant-transaction.ts';
import type { TenancyStore, TenantSummary } from '../application/ports.ts';
import { RENAME_AUDIT, formatScope, renameDetail } from '../domain/scope.ts';

export const createSqlTenancyStore = (sql: SqlClient): TenancyStore => ({
  async ensureTenant(scope, label, at) {
    await sql.query(
      `INSERT INTO tenants (company_id, project_id, label, created_at) VALUES ($1, $2, $3, $4)
       ON CONFLICT DO NOTHING`,
      [scope.companyId, scope.projectId, label, at],
    );
  },

  async createTenantWithGrant(scope, label, username, at) {
    return sql.transaction(async (tx) => {
      const created = await tx.query(
        `INSERT INTO tenants (company_id, project_id, label, created_at) VALUES ($1, $2, $3, $4)
         ON CONFLICT DO NOTHING RETURNING tenant_id`,
        [scope.companyId, scope.projectId, label, at],
      );
      if (created.length === 0) return false;
      await tx.query('INSERT INTO grants (username, tenant_id, created_at) VALUES ($1, $2, $3)', [
        username,
        formatScope(scope),
        at,
      ]);
      return true;
    });
  },

  async tenantExists(scope) {
    const rows = await sql.query(
      'SELECT 1 FROM tenants WHERE company_id = $1 AND project_id = $2',
      [scope.companyId, scope.projectId],
    );
    return rows.length > 0;
  },

  async tenantLabel(scope) {
    const [row] = await sql.query<{ label: string }>(
      'SELECT label FROM tenants WHERE company_id = $1 AND project_id = $2',
      [scope.companyId, scope.projectId],
    );
    return row?.label ?? null;
  },

  async grant(username, scope, at) {
    await sql.query(
      `INSERT INTO grants (username, tenant_id, created_at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [username, formatScope(scope), at],
    );
  },

  async revoke(username, scope) {
    const rows = await sql.query(
      'DELETE FROM grants WHERE username = $1 AND tenant_id = $2 RETURNING username',
      [username, formatScope(scope)],
    );
    return rows.length === 1;
  },

  /**
   * The tenant row is locked and updated first, as the owner; entering the project then drops
   * to the role that can append only to that project's audit trail.
   */
  async renameTenant(scope, label, by, at) {
    return sql.transaction(async (tx) => {
      const [row] = await tx.query<{ tenant_id: string; label: string }>(
        'SELECT tenant_id, label FROM tenants WHERE company_id = $1 AND project_id = $2 FOR UPDATE',
        [scope.companyId, scope.projectId],
      );
      if (!row) return false;
      await tx.query('UPDATE tenants SET label = $1 WHERE tenant_id = $2', [label, row.tenant_id]);
      await enterTenant(tx, row.tenant_id);
      await appendAudit(tx, {
        ...RENAME_AUDIT,
        recordId: row.tenant_id,
        detail: renameDetail(row.label, label, by),
        at,
      });
      return true;
    });
  },

  async listGrants(username) {
    const rows = await sql.query<{ company_id: string; project_id: string; label: string }>(
      `SELECT t.company_id, t.project_id, t.label
         FROM grants g JOIN tenants t ON t.tenant_id = g.tenant_id
        WHERE g.username = $1::text
        ORDER BY t.company_id, t.project_id`,
      [username],
    );
    return rows.map((r): TenantSummary => ({
      companyId: r.company_id,
      projectId: r.project_id,
      label: r.label,
    }));
  },
});
