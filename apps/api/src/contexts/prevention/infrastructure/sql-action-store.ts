import { appendAudit } from '../../../platform/database/audit-trail.ts';
import type { SqlClient } from '../../../platform/database/sql-client.ts';
import { withTenant } from '../../../platform/database/tenant-transaction.ts';
import type { ActionStatus, ActionStore, PreventiveAction } from '../application/index.ts';

type ActionRow = {
  id: string;
  project_id: string;
  alert_id: string;
  title: string;
  responsible: string;
  due_date: string;
  description: string;
  status: ActionStatus;
  progress: number;
  created_at: Date | string;
  updated_at: Date | string;
};

type LogRow = {
  id: string;
  action_id: string;
  created_at: Date | string;
  status: ActionStatus;
  progress: number;
  note: string;
  evidence_url: string | null;
};

const ACTION_COLUMNS = `id, project_id, alert_id, title, responsible, due_date, description, status,
  progress, created_at, updated_at`;

/** Audit module name used by app.py for action plans. */
const AUDIT_MODULE = 'PrevencionTerritorial';

const withHistory = async (tx: SqlClient, rows: ActionRow[]): Promise<PreventiveAction[]> => {
  if (rows.length === 0) return [];
  const logs = await tx.query<LogRow>(
    `SELECT id, action_id, created_at, status, progress, note, evidence_url
       FROM preventive_action_log WHERE action_id = ANY($1::text[])
      ORDER BY created_at DESC, id DESC`,
    [rows.map((r) => r.id)],
  );
  return rows.map((row) => ({
    id: row.id,
    projectId: row.project_id,
    alertId: row.alert_id,
    title: row.title,
    responsible: row.responsible,
    dueDate: row.due_date,
    description: row.description,
    status: row.status,
    progress: Number(row.progress),
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
    history: logs
      .filter((log) => log.action_id === row.id)
      .map((log) => ({
        id: log.id,
        actionId: log.action_id,
        createdAt: new Date(log.created_at),
        status: log.status,
        progress: Number(log.progress),
        note: log.note,
        evidenceUrl: log.evidence_url,
      })),
  }));
};

const insertLog = (
  tx: SqlClient,
  entry: {
    id: string;
    actionId: string;
    at: Date;
    status: ActionStatus;
    progress: number;
    note: string;
    evidenceUrl: string | null;
  },
) =>
  tx.query(
    `INSERT INTO preventive_action_log (tenant_id, id, action_id, created_at, status, progress,
       note, evidence_url)
     VALUES (current_setting('app.tenant_id', true), $1, $2, $3, $4, $5, $6, $7)`,
    [
      entry.id,
      entry.actionId,
      entry.at,
      entry.status,
      entry.progress,
      entry.note,
      entry.evidenceUrl,
    ],
  );

export const createSqlActionStore = (sql: SqlClient): ActionStore => ({
  create: (tenantId, action, logId) =>
    withTenant(sql, tenantId, async (tx) => {
      const rows = await tx.query<ActionRow>(
        `INSERT INTO preventive_actions (tenant_id, id, project_id, alert_id, title, responsible,
           due_date, description, status, progress, created_at, updated_at)
         VALUES (current_setting('app.tenant_id', true), $1, $2, $3, $4, $5, $6, $7,
           'Pendiente', 0, $8, $8)
         RETURNING ${ACTION_COLUMNS}`,
        [
          action.id,
          action.projectId,
          action.alertId,
          action.title,
          action.responsible,
          action.dueDate,
          action.description,
          action.createdAt,
        ],
      );
      await insertLog(tx, {
        id: logId,
        actionId: action.id,
        at: action.createdAt,
        status: 'Pendiente',
        progress: 0,
        note: 'Plan creado',
        evidenceUrl: null,
      });
      await appendAudit(tx, {
        module: AUDIT_MODULE,
        recordId: action.id,
        action: 'CREATE',
        detail: action.alertId,
        at: action.createdAt,
      });
      const [created] = await withHistory(tx, rows);
      if (!created) throw new Error('Action insert returned no row');
      return created;
    }),

  list: (tenantId, projectId) =>
    withTenant(sql, tenantId, async (tx) =>
      withHistory(
        tx,
        await tx.query<ActionRow>(
          `SELECT ${ACTION_COLUMNS} FROM preventive_actions WHERE project_id = $1
            ORDER BY due_date ASC, created_at DESC, id`,
          [projectId],
        ),
      ),
    ),

  get: (tenantId, id) =>
    withTenant(sql, tenantId, async (tx) => {
      const rows = await tx.query<ActionRow>(
        `SELECT ${ACTION_COLUMNS} FROM preventive_actions WHERE id = $1`,
        [id],
      );
      return (await withHistory(tx, rows))[0] ?? null;
    }),

  update: (tenantId, id, guard, change) =>
    withTenant(sql, tenantId, async (tx) => {
      // The row lock makes the reactivation check and the update one atomic step.
      const locked = await tx.query<ActionRow>(
        `SELECT ${ACTION_COLUMNS} FROM preventive_actions WHERE id = $1 FOR UPDATE`,
        [id],
      );
      const [current] = await withHistory(tx, locked);
      if (!current) return null;
      const refused = guard(current);
      if (refused !== null) return { ok: false as const, error: refused };
      const rows = await tx.query<ActionRow>(
        `UPDATE preventive_actions SET status = $2, progress = $3, updated_at = $4 WHERE id = $1
         RETURNING ${ACTION_COLUMNS}`,
        [id, change.status, change.progress, change.createdAt],
      );
      await insertLog(tx, {
        id: change.id,
        actionId: id,
        at: change.createdAt,
        status: change.status,
        progress: change.progress,
        note: change.note,
        evidenceUrl: change.evidenceUrl,
      });
      await appendAudit(tx, {
        module: AUDIT_MODULE,
        recordId: id,
        action: 'UPDATE',
        detail: `${change.status}: ${Array.from(change.note).slice(0, 200).join('')}`,
        at: change.createdAt,
      });
      const [action] = await withHistory(tx, rows);
      if (!action) throw new Error('Action update returned no row');
      return { ok: true as const, action };
    }),
});
