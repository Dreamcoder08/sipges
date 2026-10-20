import { appendAudit } from '../../../platform/database/audit-trail.ts';
import type { SqlClient } from '../../../platform/database/sql-client.ts';
import { withTenant } from '../../../platform/database/tenant-transaction.ts';
import type {
  ActionStatus,
  ActionStore,
  Blocker,
  DecisionReceipt,
  PreventiveAction,
} from '../application/index.ts';

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
  blocked_by: Blocker | null;
  blocked_reason: string | null;
  blocked_since: Date | string | null;
};

type LogRow = {
  id: string;
  action_id: string;
  created_at: Date | string;
  status: ActionStatus;
  progress: number;
  note: string;
  evidence_url: string | null;
  decided_by: string | null;
  evidence_attachment_id: string | null;
  evidence_file_name: string | null;
  evidence_sha256: string | null;
};

const ACTION_COLUMNS = `id, project_id, alert_id, title, responsible, due_date, description, status,
  progress, created_at, updated_at, blocked_by, blocked_reason, blocked_since`;

/** Audit module name used by app.py for action plans. */
const AUDIT_MODULE = 'PrevencionTerritorial';

const withHistory = async (tx: SqlClient, rows: ActionRow[]): Promise<PreventiveAction[]> => {
  if (rows.length === 0) return [];
  const logs = await tx.query<LogRow>(
    `SELECT id, action_id, created_at, status, progress, note, evidence_url, decided_by,
            evidence_attachment_id, evidence_file_name, evidence_sha256
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
    block:
      row.blocked_by && row.blocked_since
        ? {
            by: row.blocked_by,
            reason: row.blocked_reason ?? '',
            since: new Date(row.blocked_since),
          }
        : null,
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
        decidedBy: log.decided_by,
        receipt:
          log.evidence_attachment_id && log.evidence_sha256
            ? {
                attachmentId: log.evidence_attachment_id,
                fileName: log.evidence_file_name ?? '',
                sha256: log.evidence_sha256,
              }
            : null,
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
    decidedBy: string | null;
    receipt: DecisionReceipt | null;
  },
) =>
  tx.query(
    `INSERT INTO preventive_action_log (tenant_id, id, action_id, created_at, status, progress,
       note, evidence_url, decided_by, evidence_attachment_id, evidence_file_name, evidence_sha256)
     VALUES (current_setting('app.tenant_id', true), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      entry.id,
      entry.actionId,
      entry.at,
      entry.status,
      entry.progress,
      entry.note,
      entry.evidenceUrl,
      entry.decidedBy,
      entry.receipt?.attachmentId ?? null,
      entry.receipt?.fileName ?? null,
      entry.receipt?.sha256 ?? null,
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
        decidedBy: null,
        receipt: null,
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
      if (change.block !== undefined) {
        // The waiting time keeps counting while the plan waits on the same party.
        await tx.query(
          `UPDATE preventive_actions SET blocked_by = $2, blocked_reason = $3,
             blocked_since = CASE WHEN blocked_by IS NOT DISTINCT FROM $2 AND $2 IS NOT NULL
               THEN blocked_since ELSE $4 END
           WHERE id = $1`,
          [id, change.block?.by ?? null, change.block?.reason ?? null, change.block?.since ?? null],
        );
      }
      await insertLog(tx, {
        id: change.id,
        actionId: id,
        at: change.createdAt,
        status: change.status,
        progress: change.progress,
        note: change.note,
        evidenceUrl: change.evidenceUrl,
        decidedBy: change.decidedBy,
        receipt: change.receipt,
      });
      const receipt = change.receipt ? ` · sha256 ${change.receipt.sha256.slice(0, 12)}` : '';
      await appendAudit(tx, {
        module: AUDIT_MODULE,
        recordId: id,
        action: 'UPDATE',
        detail: `${change.status}: ${Array.from(change.note).slice(0, 200).join('')}${receipt}`,
        at: change.createdAt,
      });
      const fresh =
        change.block === undefined
          ? rows
          : await tx.query<ActionRow>(
              `SELECT ${ACTION_COLUMNS} FROM preventive_actions WHERE id = $1`,
              [id],
            );
      const [action] = await withHistory(tx, fresh);
      if (!action) throw new Error('Action update returned no row');
      return { ok: true as const, action };
    }),
});
