import type { SqlClient } from '../../../platform/database/sql-client.ts';
import type { TenancyStore, TenantSummary } from '../application/ports.ts';
import { formatScope } from '../domain/scope.ts';

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

  async listGrants(username) {
    const rows = await sql.query<{ company_id: string; project_id: string; label: string }>(
      `SELECT t.company_id, t.project_id, t.label
         FROM grants g JOIN tenants t ON t.tenant_id = g.tenant_id
        WHERE g.username = $1
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
