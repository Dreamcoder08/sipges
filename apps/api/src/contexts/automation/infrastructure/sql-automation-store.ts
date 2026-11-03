import { appendAudit } from '../../../platform/database/audit-trail.ts';
import type { SqlClient } from '../../../platform/database/sql-client.ts';
import { withTenant } from '../../../platform/database/tenant-transaction.ts';
import type {
  AutomationStore,
  ClaimedRun,
  RunView,
  StoredChannel,
  StoredRule,
} from '../application/ports.ts';
import type { ChannelKind } from '../domain/channels.ts';
import {
  AUTOMATION_AUDIT_MODULE,
  type AuditEvent,
  type Condition,
  type RuleAction,
} from '../domain/rules.ts';

type RuleRow = {
  id: number;
  name: string;
  enabled: boolean;
  trigger_module: string;
  trigger_actions: string[];
  conditions: Condition[];
  actions: RuleAction[];
  created_by: string;
  created_at: Date | string;
  updated_at: Date | string;
};

const toRule = (row: RuleRow): StoredRule => ({
  id: Number(row.id),
  name: row.name,
  enabled: row.enabled,
  module: row.trigger_module,
  actions: row.trigger_actions,
  conditions: row.conditions,
  steps: row.actions,
  createdBy: row.created_by,
  createdAt: new Date(row.created_at),
  updatedAt: new Date(row.updated_at),
});

/** Events are stored as JSON; dates come back as strings. */
type StoredEvent = Omit<AuditEvent, 'at'> & { at: string };
const toStoredEvent = (event: AuditEvent): StoredEvent => ({
  ...event,
  at: event.at.toISOString(),
});
const fromStoredEvent = (event: StoredEvent): AuditEvent => ({ ...event, at: new Date(event.at) });

const RULE_COLUMNS = `id, name, enabled, trigger_module, trigger_actions, conditions, actions,
  created_by, created_at, updated_at`;

const audit = (tx: SqlClient, recordId: string | null, action: string, detail: string, at: Date) =>
  appendAudit(tx, { module: AUTOMATION_AUDIT_MODULE, recordId, action, detail, at });

/**
 * How long an audit event may stay uncommitted after its timestamp and still be scanned. Well
 * above a request's lifetime on Workers (30 s); on Node nothing enforces it, so a transaction
 * that writes audit rows must not stay open longer.
 */
const CURSOR_SETTLE_MS = 60_000;

/** Rules, channels, runs and notifications under forced RLS (docs/adr/0014). */
export const createSqlAutomationStore = (sql: SqlClient): AutomationStore => ({
  activeTenants: async () =>
    (
      await sql.query<{ tenant_id: string }>(
        // As the owner, outside any tenant: cursors are the one table whose RLS is not forced.
        'SELECT tenant_id FROM automation_cursors ORDER BY tenant_id',
      )
    ).map((row) => row.tenant_id),

  rules: (tenantId) =>
    withTenant(sql, tenantId, async (tx) =>
      (
        await tx.query<RuleRow>(`SELECT ${RULE_COLUMNS} FROM automation_rules ORDER BY name, id`)
      ).map(toRule),
    ),

  saveRule: (tenantId, id, rule, actor, at) =>
    withTenant(sql, tenantId, async (tx) => {
      const duplicate = await tx.query(
        'SELECT 1 FROM automation_rules WHERE name = $1 AND ($2::integer IS NULL OR id <> $2)',
        [rule.name, id],
      );
      if (duplicate.length > 0) return { ok: false, error: 'duplicate' } as const;
      const values = [
        rule.name,
        rule.enabled,
        rule.module,
        [...rule.actions],
        JSON.stringify(rule.conditions),
        JSON.stringify(rule.steps),
        at,
      ];
      let savedId: number;
      if (id === null) {
        const [row] = await tx.query<{ id: number }>(
          `INSERT INTO automation_rules
             (tenant_id, name, enabled, trigger_module, trigger_actions, conditions, actions,
              created_by, created_at, updated_at)
           VALUES (current_setting('app.tenant_id', true), $1, $2, $3, $4::text[], $5::jsonb,
                   $6::jsonb, $8, $7, $7)
           RETURNING id`,
          [...values, actor],
        );
        savedId = Number(row?.id);
        // Runtime/source activation may already have registered a stale cursor. The first
        // current rule still starts now; later rules must preserve pending event processing.
        await tx.query(
          `INSERT INTO automation_cursors (tenant_id, last_audit_id)
           SELECT current_setting('app.tenant_id', true), COALESCE(max(id), 0) FROM audit
           ON CONFLICT (tenant_id) DO UPDATE
             SET last_audit_id = GREATEST(automation_cursors.last_audit_id, EXCLUDED.last_audit_id)
             WHERE (SELECT count(*) FROM automation_rules) = 1`,
        );
      } else {
        const updated = await tx.query<{ id: number }>(
          `UPDATE automation_rules
           SET name = $1, enabled = $2, trigger_module = $3, trigger_actions = $4::text[],
               conditions = $5::jsonb, actions = $6::jsonb, updated_at = $7
           WHERE id = $8 RETURNING id`,
          [...values, id],
        );
        if (updated.length === 0) return { ok: false, error: 'missing' } as const;
        savedId = id;
      }
      await audit(
        tx,
        String(savedId),
        id === null ? 'CREATE' : 'UPDATE',
        `Regla «${rule.name}» ${rule.enabled ? 'activa' : 'en pausa'}`,
        at,
      );
      return { ok: true, id: savedId } as const;
    }),

  deleteRule: (tenantId, id, at) =>
    withTenant(sql, tenantId, async (tx) => {
      const [row] = await tx.query<{ name: string }>(
        'DELETE FROM automation_rules WHERE id = $1 RETURNING name',
        [id],
      );
      if (!row) return false;
      await audit(tx, String(id), 'DELETE', `Regla «${row.name}» eliminada`, at);
      return true;
    }),

  channels: (tenantId) =>
    withTenant(sql, tenantId, async (tx) =>
      (
        await tx.query<{
          id: number;
          kind: ChannelKind;
          name: string;
          target_hint: string;
          created_by: string;
          created_at: Date | string;
        }>(
          `SELECT id, kind, name, target_hint, created_by, created_at
           FROM integration_channels ORDER BY name, id`,
        )
      ).map((row): StoredChannel => ({
        id: Number(row.id),
        kind: row.kind,
        name: row.name,
        targetHint: row.target_hint,
        createdBy: row.created_by,
        createdAt: new Date(row.created_at),
      })),
    ),

  createChannel: (tenantId, channel, actor, at) =>
    withTenant(sql, tenantId, async (tx) => {
      const [row] = await tx.query<{ id: number }>(
        `INSERT INTO integration_channels
           (tenant_id, kind, name, target_hint, sealed_config, created_by, created_at)
         VALUES (current_setting('app.tenant_id', true), $1, $2, $3, $4, $5, $6)
         ON CONFLICT (tenant_id, name) DO NOTHING RETURNING id`,
        [channel.kind, channel.name, channel.targetHint, channel.sealed, actor, at],
      );
      if (!row) return { ok: false, error: 'duplicate' } as const;
      await audit(
        tx,
        `canal-${row.id}`,
        'CREATE',
        `Canal ${channel.kind} «${channel.name}» hacia ${channel.targetHint}`,
        at,
      );
      return { ok: true, id: Number(row.id) } as const;
    }),

  deleteChannel: (tenantId, id, at) =>
    withTenant(sql, tenantId, async (tx) => {
      const used = await tx.query(
        `SELECT 1 FROM automation_rules
         WHERE enabled AND actions @> jsonb_build_array(jsonb_build_object('channelId', $1::integer))`,
        [id],
      );
      if (used.length > 0) return 'in_use';
      const [row] = await tx.query<{ name: string }>(
        'DELETE FROM integration_channels WHERE id = $1 RETURNING name',
        [id],
      );
      if (!row) return 'missing';
      await audit(tx, `canal-${id}`, 'DELETE', `Canal «${row.name}» eliminado`, at);
      return 'deleted';
    }),

  sealedChannel: (tenantId, id) =>
    withTenant(sql, tenantId, async (tx) => {
      const [row] = await tx.query<{ sealed_config: string }>(
        'SELECT sealed_config FROM integration_channels WHERE id = $1',
        [id],
      );
      return row?.sealed_config ?? null;
    }),

  scan: (tenantId, limit, plan, at) =>
    withTenant(sql, tenantId, async (tx) => {
      const [cursor] = await tx.query<{ last_audit_id: number }>(
        'SELECT last_audit_id FROM automation_cursors FOR UPDATE',
      );
      if (!cursor) return { scanned: 0, queued: 0 };
      const rows = await tx.query<{
        id: number;
        ts: Date | string;
        module: string;
        record_id: string | null;
        action: string;
        detail: string | null;
        payload: Record<string, unknown> | null;
        marking: string | null;
      }>(
        `SELECT a.id, a.ts, a.module, a.record_id, a.action, a.detail, CASE WHEN a.module = 'InteligenciaDigital' THEN a.event_payload ELSE r.payload END AS payload, r.marking
         FROM audit a
         LEFT JOIN module_records r ON r.module = a.module AND r.id = a.record_id
         WHERE a.id > $1 ORDER BY a.id LIMIT $2`,
        [cursor.last_audit_id, limit],
      );
      if (rows.length === 0) return { scanned: 0, queued: 0 };
      const events: AuditEvent[] = rows.map((row) => ({
        auditId: Number(row.id),
        at: new Date(row.ts),
        module: row.module,
        recordId: row.record_id,
        action: row.action,
        detail: row.detail ?? '',
        record: row.payload ? { payload: row.payload, marking: row.marking ?? 'interno' } : null,
      }));
      const rules = (
        await tx.query<RuleRow>(`SELECT ${RULE_COLUMNS} FROM automation_rules WHERE enabled`)
      ).map(toRule);
      const runs = rules.length > 0 ? plan(events, rules) : [];
      let queued = 0;
      for (const run of runs) {
        const inserted = await tx.query(
          `INSERT INTO automation_runs
             (tenant_id, rule_id, audit_id, action_index, kind, event, next_attempt_at, created_at)
           VALUES (current_setting('app.tenant_id', true), $1, $2, $3, $4, $5::jsonb, $6, $6)
           ON CONFLICT DO NOTHING RETURNING id`,
          [
            run.ruleId,
            run.auditId,
            run.actionIndex,
            run.kind,
            JSON.stringify(toStoredEvent(run.event)),
            at,
          ],
        );
        queued += inserted.length;
      }
      // Ids are taken when a row is inserted, not when it commits, so a slower writer can commit
      // a lower id after a higher one was scanned. The cursor only passes events older than the
      // settle window; newer ones are read again next time and their runs are not duplicated
      // (automation_runs is unique per rule, audit id and step).
      const horizon = at.getTime() - CURSOR_SETTLE_MS;
      let settled = cursor.last_audit_id;
      for (const event of events) {
        if (event.at.getTime() > horizon) break;
        settled = event.auditId;
      }
      if (settled !== cursor.last_audit_id)
        await tx.query('UPDATE automation_cursors SET last_audit_id = $1', [settled]);
      return { scanned: events.length, queued };
    }),

  claimDue: (tenantId, limit, at, leaseUntil) =>
    withTenant(sql, tenantId, async (tx) =>
      (
        await tx.query<{
          id: number;
          rule_id: number;
          name: string;
          attempts: number;
          event: StoredEvent;
          step: RuleAction | null;
        }>(
          `WITH due AS (
             SELECT id FROM automation_runs
             WHERE status = 'pending' AND next_attempt_at <= $1
             ORDER BY next_attempt_at, id LIMIT $2 FOR UPDATE SKIP LOCKED
           ), claimed AS (
             UPDATE automation_runs u SET attempts = u.attempts + 1, next_attempt_at = $3
             FROM due WHERE u.id = due.id
             RETURNING u.id, u.rule_id, u.attempts, u.event, u.action_index
           )
           SELECT c.id, c.rule_id, r.name, c.attempts, c.event, r.actions -> c.action_index AS step
           FROM claimed c JOIN automation_rules r ON r.id = c.rule_id
           ORDER BY c.id`,
          [at, limit, leaseUntil],
        )
      ).map((row): ClaimedRun => ({
        id: Number(row.id),
        ruleId: Number(row.rule_id),
        ruleName: row.name,
        attempts: Number(row.attempts),
        event: fromStoredEvent(row.event),
        step: row.step ?? null,
      })),
    ),

  finishRun: (tenantId, id, outcome, at) =>
    withTenant(sql, tenantId, async (tx) => {
      if (outcome.status === 'done') {
        await tx.query(
          `UPDATE automation_runs SET status = 'done', last_error = '', finished_at = $2
           WHERE id = $1`,
          [id, at],
        );
        return;
      }
      await tx.query(
        `UPDATE automation_runs
         SET status = $2, last_error = $3, next_attempt_at = $4,
             finished_at = CASE WHEN $2 = 'failed' THEN $5::timestamptz END
         WHERE id = $1`,
        [id, outcome.status, outcome.error, outcome.retryAt, at],
      );
    }),

  runs: (tenantId, limit) =>
    withTenant(sql, tenantId, async (tx) =>
      (
        await tx.query<{
          id: number;
          rule_id: number;
          name: string;
          kind: string;
          status: RunView['status'];
          attempts: number;
          last_error: string;
          event: StoredEvent;
          created_at: Date | string;
          finished_at: Date | string | null;
          next_attempt_at: Date | string;
        }>(
          `SELECT u.id, u.rule_id, r.name, u.kind, u.status, u.attempts, u.last_error, u.event,
                  u.created_at, u.finished_at, u.next_attempt_at
           FROM automation_runs u JOIN automation_rules r ON r.id = u.rule_id
           ORDER BY u.id DESC LIMIT $1`,
          [limit],
        )
      ).map((row): RunView => ({
        id: Number(row.id),
        ruleId: Number(row.rule_id),
        ruleName: row.name,
        kind: row.kind,
        status: row.status,
        attempts: Number(row.attempts),
        lastError: row.last_error,
        event: fromStoredEvent(row.event),
        createdAt: new Date(row.created_at),
        finishedAt: row.finished_at ? new Date(row.finished_at) : null,
        nextAttemptAt: new Date(row.next_attempt_at),
      })),
    ),

  notify: (tenantId, n, at) =>
    withTenant(sql, tenantId, async (tx) => {
      const [row] = await tx.query<{ id: number }>(
        `INSERT INTO notifications
           (tenant_id, title, body, module, record_id, marking, rule_id, created_at, run_id)
         VALUES (current_setting('app.tenant_id', true), $1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (tenant_id, run_id) DO UPDATE SET run_id = EXCLUDED.run_id
         RETURNING id`,
        [n.title, n.body, n.module, n.recordId, n.marking, n.ruleId, at, n.runId ?? null],
      );
      return Number(row?.id);
    }),

  inbox: (tenantId, username, limit) =>
    withTenant(sql, tenantId, async (tx) => {
      // One statement: the count and the page share a round trip and a pooled connection.
      const [row] = await tx.query<{
        unread: number | string;
        items: {
          id: number;
          title: string;
          body: string;
          module: string | null;
          record_id: string | null;
          created_at: string;
          read: boolean;
        }[];
      }>(
        `SELECT
           (SELECT count(*) FROM notifications n
            WHERE NOT EXISTS (SELECT 1 FROM notification_reads r
                              WHERE r.notification_id = n.id AND r.username = $1)) AS unread,
           coalesce((SELECT json_agg(page ORDER BY page.id DESC) FROM (
             SELECT n.id, n.title, n.body, n.module, n.record_id, n.created_at,
                    (r.username IS NOT NULL) AS read
             FROM notifications n
             LEFT JOIN notification_reads r ON r.notification_id = n.id AND r.username = $1
             ORDER BY n.id DESC LIMIT $2) page), '[]'::json) AS items`,
        [username, limit],
      );
      return {
        unread: Number(row?.unread ?? 0),
        items: (row?.items ?? []).map((item) => ({
          id: Number(item.id),
          title: item.title,
          body: item.body,
          module: item.module,
          recordId: item.record_id,
          createdAt: new Date(item.created_at),
          read: item.read,
        })),
      };
    }),

  markRead: (tenantId, username, ids, at) =>
    withTenant(sql, tenantId, async (tx) => {
      await tx.query(
        `INSERT INTO notification_reads (tenant_id, notification_id, username, read_at)
         SELECT current_setting('app.tenant_id', true), n.id, $1, $2 FROM notifications n
         WHERE $3::integer[] IS NULL OR n.id = ANY($3::integer[])
         ON CONFLICT DO NOTHING`,
        [username, at, ids === 'all' ? null : [...ids]],
      );
    }),
});
