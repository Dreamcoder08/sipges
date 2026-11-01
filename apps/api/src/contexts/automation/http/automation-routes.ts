import { createHash, timingSafeEqual } from 'node:crypto';
import {
  type AutomationOverview,
  ChannelIn,
  type ChannelOut,
  type NotificationInbox,
  NotificationReadIn,
  type PushConfig,
  PushSubscriptionIn,
  PushUnsubscribeIn,
  RuleIn,
  type RuleOut,
  type RunOut,
  type TickReport,
} from '@sipges/contracts';
import type { Context } from 'hono';
import { Hono } from 'hono';
import type { AppEnv } from '../../../platform/http/env.ts';
import { isoSeconds } from '../../../platform/http/time.ts';
import { parseIntQuery, parseJson } from '../../../platform/http/validation.ts';
import { RECORD_MODULES } from '../../records/application/index.ts';
import { formatScope } from '../../tenancy/application/index.ts';
import {
  type AutomationService,
  CONDITION_OPS,
  EVENT_ACTIONS,
  type RuleAction,
  type RuleInput,
  type RunView,
  type StoredChannel,
  type StoredRule,
} from '../application/index.ts';

/** Reached by serverless cron jobs with a bearer secret, never by browsers (ADR 0014 §4). */
export const AUTOMATION_CRON_PATH = '/system/automations/cron';

const RULE_ERRORS = {
  invalid_module: [422, 'Origen de eventos no válido'],
  invalid_action: [422, 'Acción de auditoría no válida'],
  invalid_condition: [422, 'Condición no válida'],
  invalid_step: [422, 'Acción de la regla no válida o canal inexistente'],
  missing: [404, 'Regla no encontrada'],
  duplicate: [409, 'Ya existe una regla con ese nombre'],
} as const;

const CHANNEL_ERRORS = {
  invalid_url: [422, 'La dirección debe ser una URL https válida'],
  private_host: [422, 'No se permiten destinos locales o de red privada'],
  wrong_host: [422, 'La URL no corresponde al servicio elegido'],
  invalid_settings: [422, 'Configuración del canal incompleta o no válida'],
  duplicate: [409, 'Ya existe un canal con ese nombre'],
} as const;

const tenantOf = (c: Context<AppEnv>) => formatScope(c.get('scope'));

const SLUGS: ReadonlyMap<string, string> = new Map(RECORD_MODULES.map((m) => [m.module, m.slug]));

const stepOut = (step: RuleAction): RuleOut['steps'][number] =>
  step.kind === 'evaluate'
    ? { kind: 'evaluate', title: step.title, minimum_level: step.minimumLevel }
    : step.kind === 'notify'
      ? { kind: 'notify', title: step.title }
      : { kind: 'channel', channel_id: step.channelId, title: step.title };

const ruleOut = (rule: StoredRule): RuleOut => ({
  id: rule.id,
  name: rule.name,
  enabled: rule.enabled,
  module: rule.module,
  actions: [...rule.actions],
  conditions: rule.conditions.map((c) => ({ ...c })),
  steps: rule.steps.map(stepOut),
  created_by: rule.createdBy,
  updated_at: isoSeconds(rule.updatedAt),
});

const channelOut = (channel: StoredChannel): ChannelOut => ({
  id: channel.id,
  kind: channel.kind,
  name: channel.name,
  target_hint: channel.targetHint,
  created_by: channel.createdBy,
  created_at: isoSeconds(channel.createdAt),
});

const runOut = (run: RunView): RunOut => ({
  id: run.id,
  rule_id: run.ruleId,
  rule_name: run.ruleName,
  kind: run.kind,
  status: run.status,
  attempts: run.attempts,
  last_error: run.lastError,
  event: {
    audit_id: run.event.auditId,
    at: isoSeconds(run.event.at),
    module: run.event.module,
    record_id: run.event.recordId,
    action: run.event.action,
    detail: run.event.record?.marking === 'restringido' ? '' : run.event.detail,
  },
  created_at: isoSeconds(run.createdAt),
  finished_at: run.finishedAt ? isoSeconds(run.finishedAt) : null,
  next_attempt_at: isoSeconds(run.nextAttemptAt),
});

const toInput = (body: RuleIn): RuleInput => ({
  name: body.name,
  enabled: body.enabled,
  module: body.module,
  actions: body.actions,
  conditions: body.conditions,
  steps: body.steps.map((step) =>
    step.kind === 'evaluate'
      ? { kind: 'evaluate', title: step.title, minimumLevel: step.minimum_level }
      : step.kind === 'notify'
        ? { kind: 'notify', title: step.title }
        : { kind: 'channel', channelId: step.channel_id, title: step.title },
  ),
});

const idParam = (c: Context) => {
  const raw = c.req.param('id') ?? '';
  return /^\d{1,9}$/.test(raw) ? Number(raw) : null;
};

const digest = (value: string) => createHash('sha256').update(value).digest();

/** Constant-time comparison of a bearer token against the configured secret. */
export const bearerMatches = (header: string | undefined, secret: string | undefined) => {
  if (!secret || !header?.startsWith('Bearer ')) return false;
  return timingSafeEqual(digest(header.slice(7).trim()), digest(secret));
};

/** Rules, channels and runs for administrators; the inbox for every member (ADR 0014). */
export const automationRoutes = (
  automation: AutomationService,
  cronSecret: string | undefined,
  options?: { runCron?: () => Promise<TickReport> },
) =>
  new Hono<AppEnv>()
    // Some schedulers call with GET, others with POST.
    .on(['GET', 'POST'], AUTOMATION_CRON_PATH, async (c) => {
      if (!bearerMatches(c.req.header('authorization'), cronSecret)) {
        return c.json({ detail: 'Credencial de cron no válida' }, 401);
      }
      return c.json((await (options?.runCron?.() ?? automation.tick())) satisfies TickReport);
    })

    .get('/system/automations', async (c) => {
      const tenant = tenantOf(c);
      const [rules, channels, runs] = await Promise.all([
        automation.rules(tenant),
        automation.channels(tenant),
        automation.runs(tenant, 50),
      ]);
      return c.json({
        sources: automation.sources().map((s) => ({ ...s })),
        actions: [...EVENT_ACTIONS],
        operators: [...CONDITION_OPS],
        rules: rules.map(ruleOut),
        channels: channels.map(channelOut),
        runs: runs.map(runOut),
      } satisfies AutomationOverview);
    })

    .get('/system/automations/runs', async (c) => {
      const limit = parseIntQuery(c, 'limit', 50);
      if (!limit.ok) return limit.response;
      return c.json((await automation.runs(tenantOf(c), limit.value)).map(runOut));
    })

    .post('/system/automations/rules', async (c) => {
      const body = await parseJson(c, RuleIn);
      if (!body.ok) return body.response;
      const saved = await automation.saveRule(
        tenantOf(c),
        null,
        toInput(body.value),
        c.get('identity').username,
      );
      if (!saved.ok) {
        const [status, detail] = RULE_ERRORS[saved.error];
        return c.json({ detail }, status);
      }
      return c.json({ ok: true, id: saved.value });
    })

    .put('/system/automations/rules/:id', async (c) => {
      const id = idParam(c);
      if (id === null) return c.json({ detail: RULE_ERRORS.missing[1] }, 404);
      const body = await parseJson(c, RuleIn);
      if (!body.ok) return body.response;
      const saved = await automation.saveRule(
        tenantOf(c),
        id,
        toInput(body.value),
        c.get('identity').username,
      );
      if (!saved.ok) {
        const [status, detail] = RULE_ERRORS[saved.error];
        return c.json({ detail }, status);
      }
      return c.json({ ok: true, id: saved.value });
    })

    .delete('/system/automations/rules/:id', async (c) => {
      const id = idParam(c);
      const removed = id !== null && (await automation.deleteRule(tenantOf(c), id));
      return removed ? c.json({ ok: true }) : c.json({ detail: RULE_ERRORS.missing[1] }, 404);
    })

    .post('/system/automations/channels', async (c) => {
      const body = await parseJson(c, ChannelIn);
      if (!body.ok) return body.response;
      const created = await automation.createChannel(
        tenantOf(c),
        body.value,
        c.get('identity').username,
      );
      if (!created.ok) {
        const [status, detail] = CHANNEL_ERRORS[created.error];
        return c.json({ detail }, status);
      }
      return c.json({ ok: true, id: created.value });
    })

    .post('/system/automations/channels/:id/test', async (c) => {
      const id = idParam(c);
      if (id === null) return c.json({ detail: 'Canal no encontrado' }, 404);
      const sent = await automation.testChannel(tenantOf(c), id);
      return sent.ok ? c.json({ ok: true }) : c.json({ detail: sent.error }, 502);
    })

    .delete('/system/automations/channels/:id', async (c) => {
      const id = idParam(c);
      const outcome = id === null ? 'missing' : await automation.deleteChannel(tenantOf(c), id);
      if (outcome === 'in_use')
        return c.json({ detail: 'Una regla activa usa este canal; pausa o edita la regla' }, 409);
      return outcome === 'deleted'
        ? c.json({ ok: true })
        : c.json({ detail: 'Canal no encontrado' }, 404);
    })

    .post('/system/automations/tick', async (c) =>
      c.json((await automation.tick(tenantOf(c))) satisfies TickReport),
    )

    .get('/system/notifications', async (c) => {
      const limit = parseIntQuery(c, 'limit', 30);
      if (!limit.ok) return limit.response;
      const tenant = tenantOf(c);
      const username = c.get('identity').username;
      const [unread, items] = await Promise.all([
        automation.unread(tenant, username),
        automation.notifications(tenant, username, limit.value),
      ]);
      return c.json({
        unread,
        items: items.map((n) => ({
          id: n.id,
          title: n.title,
          body: n.body,
          module: n.module,
          record_id: n.recordId,
          ...(n.module === 'InteligenciaDigital' && n.recordId
            ? { href: `/inteligencia-redes?alert=${encodeURIComponent(n.recordId)}` }
            : {}),
          link:
            n.module && n.recordId && SLUGS.has(n.module)
              ? { module: SLUGS.get(n.module) ?? '', id: n.recordId }
              : null,
          created_at: isoSeconds(n.createdAt),
          read: n.read,
        })),
      } satisfies NotificationInbox);
    })

    .post('/system/notifications/read', async (c) => {
      const body = await parseJson(c, NotificationReadIn);
      if (!body.ok) return body.response;
      await automation.markRead(
        tenantOf(c),
        c.get('identity').username,
        'all' in body.value ? 'all' : body.value.ids,
      );
      return c.json({ ok: true });
    })
    .get('/system/notifications/push', (c) => {
      const key = automation.pushKey();
      return c.json({ enabled: key !== null, public_key: key } satisfies PushConfig);
    })

    .get('/system/notifications/push/state', async (c) =>
      c.json(await automation.pushState(c.get('identity').username)),
    )
    .post('/system/notifications/push/test', async (c) => {
      const result = await automation.testPush(c.get('identity').username);
      return c.json(result, result.status === 'failed' ? 502 : 200);
    })
    .post('/system/notifications/push', async (c) => {
      const body = await parseJson(c, PushSubscriptionIn);
      if (!body.ok) return body.response;
      const saved = await automation.subscribePush(c.get('identity').username, {
        endpoint: body.value.endpoint,
        p256dh: body.value.keys.p256dh,
        auth: body.value.keys.auth,
      });
      if (!saved.ok)
        return saved.error === 'disabled'
          ? c.json({ detail: 'Las notificaciones en dispositivos no están configuradas' }, 409)
          : c.json({ detail: 'Suscripción de notificaciones no válida' }, 422);
      return c.json({ ok: true });
    })

    .post('/system/notifications/push/unsubscribe', async (c) => {
      const body = await parseJson(c, PushUnsubscribeIn);
      if (!body.ok) return body.response;
      await automation.unsubscribePush(c.get('identity').username, body.value.endpoint);
      return c.json({ ok: true });
    });
