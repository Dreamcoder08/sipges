import type { SqlClient } from '../../../platform/database/sql-client.ts';
import { withTenant } from '../../../platform/database/tenant-transaction.ts';
import type { RuntimeAttempt, RuntimeSource, RuntimeStore } from '../application/index.ts';
export const createSqlAutomationRuntimeStore = (sql: SqlClient): RuntimeStore => ({
  dueTenants: async (limit) => {
    return (
      await sql.query<{ tenant_id: string }>(
        `SELECT tenant_id FROM automation_cursors ORDER BY last_tick_finished_at ASC NULLS FIRST,tenant_id LIMIT $1`,
        [limit],
      )
    ).map((r) => r.tenant_id);
  },
  start: (tenantId, token, source, at) =>
    withTenant(sql, tenantId, async (tx) => {
      await tx.query(
        `INSERT INTO automation_cursors(tenant_id,last_audit_id,last_tick_token,last_tick_source,last_tick_started_at,last_tick_status)
      SELECT $4,COALESCE(max(id),0),$1,$2,$3,'running' FROM audit ON CONFLICT(tenant_id) DO UPDATE SET
      last_tick_token=EXCLUDED.last_tick_token,last_tick_source=EXCLUDED.last_tick_source,
      last_tick_started_at=EXCLUDED.last_tick_started_at,last_tick_finished_at=NULL,last_tick_status='running',last_tick_report=NULL,last_tick_error=''`,
        [token, source, at, tenantId],
      );
    }),
  finish: (tenantId, token, outcome, at) =>
    withTenant(sql, tenantId, async (tx) => {
      await tx.query(
        `UPDATE automation_cursors SET last_tick_finished_at=$1,last_tick_status=$2,last_tick_report=$3::jsonb,last_tick_error=$4 WHERE tenant_id=$5 AND last_tick_token=$6`,
        [
          at,
          outcome.status,
          outcome.report === null ? null : JSON.stringify(outcome.report),
          outcome.error,
          tenantId,
          token,
        ],
      );
    }),
  state: (tenantId) =>
    withTenant(sql, tenantId, async (tx) => {
      const [r] = await tx.query<{
        last_tick_started_at: Date | string | null;
        last_tick_finished_at: Date | string | null;
        last_tick_source: RuntimeSource;
        last_tick_status: RuntimeAttempt['status'];
        last_tick_report: RuntimeAttempt['report'];
        last_tick_error: string;
      }>(
        `SELECT last_tick_started_at,last_tick_finished_at,last_tick_source,last_tick_status,last_tick_report,last_tick_error FROM automation_cursors WHERE tenant_id=$1`,
        [tenantId],
      );
      if (!r?.last_tick_started_at) return null;
      return {
        startedAt: new Date(r.last_tick_started_at),
        finishedAt: r.last_tick_finished_at ? new Date(r.last_tick_finished_at) : null,
        source: r.last_tick_source,
        status: r.last_tick_status,
        report: r.last_tick_report,
        error: r.last_tick_error,
      };
    }),
});
