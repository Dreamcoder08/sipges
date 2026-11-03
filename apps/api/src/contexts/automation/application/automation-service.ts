import { type Result, err, ok } from '@sipges/kernel';
import {
  type ChannelConfig,
  type ChannelError,
  type ChannelKind,
  isPushEndpoint,
  validateChannel,
} from '../domain/channels.ts';
import { log } from '../../../platform/observability/logger.ts';
import {
  AUTOMATION_AUDIT_MODULE,
  type AuditEvent,
  type Rule,
  type RuleError,
  type RuleInput,
  SYSTEM_EVENT_SOURCES,
  describeEvent,
  renderTitle,
  retryDelayMinutes,
  ruleMatches,
  validateRule,
} from '../domain/rules.ts';
import type {
  AutomationStore,
  ChannelSender,
  ClaimedRun,
  Clock,
  NewRun,
  PushSender,
  PushStore,
  PushSubscription,
  SecretSealer,
  SendAudit,
  SendAuditEntry,
} from './ports.ts';

/** Audit rows matched per tenant and tick; the cursor catches up over later ticks. */
export const SCAN_BATCH = 500;
/** Runs delivered per tenant and tick. */
export const DELIVERY_BATCH = 50;
/** A claimed run is retried by another tick if its delivery never reports back. */
export const LEASE_SECONDS = 120;

export type TickReport = {
  readonly tenants: number;
  readonly scanned: number;
  readonly queued: number;
  readonly delivered: number;
  readonly retrying: number;
  readonly failed: number;
};

export type EventSource = { readonly module: string; readonly label: string };

/** Matches each event against each rule and yields one run per step of every match. */
export const planRuns = (events: readonly AuditEvent[], rules: readonly Rule[]): NewRun[] =>
  events.flatMap((event) =>
    rules
      .filter((rule) => ruleMatches(rule, event))
      .flatMap((rule) =>
        rule.steps.map((step, actionIndex) => ({
          ruleId: rule.id,
          auditId: event.auditId,
          actionIndex,
          kind: step.kind,
          event,
        })),
      ),
  );

/** The webhook body: the event, and the record only when it is not restricted (ADR 0014 §5). */
const eventBody = (tenantId: string, event: AuditEvent) => ({
  type: `sipges.${event.module.toLowerCase()}.${event.action.toLowerCase()}`,
  tenant: tenantId,
  audit_id: event.auditId,
  at: event.at.toISOString(),
  module: event.module,
  record_id: event.recordId,
  action: event.action,
  detail: event.record?.marking === 'restringido' ? '' : event.detail,
  marking: event.record?.marking ?? null,
  record: event.record && event.record.marking !== 'restringido' ? event.record.payload : null,
});

const errorText = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').slice(0, 300);

export const createAutomationService = (deps: {
  executionBudgetMs?: number;
  evaluateNarrative?: (
    tenantId: string,
    event: AuditEvent,
    minimumLevel: 'Media' | 'Alta',
  ) => Promise<{ outcome: 'created' | 'duplicate' | 'ineligible'; alertId?: string }>;
  store: AutomationStore;
  sender: ChannelSender;
  sealer: SecretSealer;
  clock: Clock;
  /** Records modules (stored name and URL slug), which are event sources too. */
  recordModules: readonly { readonly module: string; readonly slug: string }[];
  /** Browser push; absent when no VAPID keys are configured. */
  push?: { readonly store: PushStore; readonly sender: PushSender | null };
  /** Audit trail of outbound sends (S8); absent only in tests that do not check it. */
  audit?: SendAudit;
}) => {
  const { store, sender, sealer, clock } = deps;

  /**
   * Best effort by design: the send already happened (or failed) when this runs, so a failing
   * audit write is logged and swallowed. Failing the run would retry and repeat the message.
   */
  const audited = async (
    tenantId: string,
    action: SendAuditEntry['action'],
    detail: string,
  ): Promise<void> => {
    if (!deps.audit) return;
    try {
      await deps.audit.append(tenantId, {
        module: AUTOMATION_AUDIT_MODULE,
        recordId: null,
        action,
        detail,
        at: clock.now(),
      });
    } catch (error) {
      log('error', 'automation send audit failed', {
        action,
        error: error instanceof Error ? error.name : 'unknown',
      });
    }
  };
  const slugs = new Map(deps.recordModules.map((m) => [m.module, m.slug]));
  const sources: EventSource[] = [
    ...deps.recordModules.map(({ module }) => ({ module, label: module.replaceAll('_', ' ') })),
    ...SYSTEM_EVENT_SOURCES,
  ];
  const knownModules = new Set(sources.map((s) => s.module));

  const openChannel = async (tenantId: string, id: number): Promise<ChannelConfig | null> => {
    const sealed = await store.sealedChannel(tenantId, id);
    return sealed ? (JSON.parse(sealer.open(sealed)) as ChannelConfig) : null;
  };

  const eventUrl = (event: AuditEvent) => {
    if (event.module === 'InteligenciaDigital' && event.recordId)
      return `/inteligencia-redes?alert=${encodeURIComponent(event.recordId)}`;
    const slug = slugs.get(event.module);
    return slug && event.recordId
      ? `/objeto/${encodeURIComponent(slug)}/${encodeURIComponent(event.recordId)}`
      : '/';
  };
  const deliverPush = async (tenantId: string, deadline: number) => {
    const push = deps.push;
    if (!push?.sender || !push.store.claim || !push.store.finish) return;
    for (let count = 0; count < DELIVERY_BATCH && performance.now() < deadline; count++) {
      const at = clock.now();
      const deliveries = await push.store.claim(
        tenantId,
        at,
        new Date(at.getTime() + LEASE_SECONDS * 1000),
      );
      if (!deliveries.length) break;
      for (const d of deliveries) {
        const audit = (outcome: string) =>
          audited(tenantId, 'PUSH_SEND', `Envío push · entrega ${d.id} · ${outcome}`);
        let sent = false;
        try {
          const result = await push.sender.send(d.subscription, d.payload, clock.now());
          sent = true;
          // Audited before any bookkeeping, so a send that happened always leaves its row.
          await audit(result === 'gone' ? 'expirado' : 'aceptado');
          if (result === 'gone') await push.store.forget(d.subscription.endpoint);
          await push.store.finish(
            tenantId,
            d.id,
            result === 'gone' ? 'failed' : 'accepted',
            result === 'gone' ? 'Suscripción expirada' : '',
            clock.now(),
          );
        } catch (error) {
          if (!sent) await audit('fallido');
          const delay = retryDelayMinutes(d.attempts);
          await push.store.finish(
            tenantId,
            d.id,
            delay === null ? 'failed' : 'pending',
            errorText(error),
            new Date(clock.now().getTime() + (delay ?? 0) * 60000),
          );
        }
      }
    }
  };
  const execute = async (tenantId: string, run: ClaimedRun): Promise<void> => {
    const { step, event } = run;
    if (!step) throw new Error('La regla ya no tiene esta acción');
    const title = renderTitle(step.title, event);
    const text = describeEvent(event);
    if (step.kind === 'evaluate') {
      if (
        event.module !== 'Narrativas' ||
        !['CREATE', 'UPDATE'].includes(event.action) ||
        !event.record ||
        event.record.marking === 'restringido'
      )
        return;
      if (!deps.evaluateNarrative) throw new Error('Evaluación de narrativas no configurada');
      await deps.evaluateNarrative(tenantId, event, step.minimumLevel);
      return;
    }
    if (step.kind === 'notify') {
      const notificationId = await store.notify(
        tenantId,
        {
          runId: run.id,
          title,
          body: text,
          module: event.module,
          recordId: event.recordId,
          marking: event.record?.marking ?? 'interno',
          ruleId: run.ruleId,
        },
        clock.now(),
      );
      await deps.push?.store.enqueue?.(
        tenantId,
        notificationId,
        event.record?.marking === 'restringido',
        { title, body: text, url: eventUrl(event) },
        clock.now(),
      );
      return;
    }
    const config = await openChannel(tenantId, step.channelId);
    if (!config) throw new Error('El canal ya no existe');
    const detail = `Envío ${config.kind} · regla ${run.ruleId} · canal ${step.channelId} · evento ${event.auditId}`;
    try {
      await sender.send(config, {
        id: `msg_${tenantId.replace(/[^A-Za-z0-9]/g, '_')}_${run.id}`,
        title,
        text,
        tenantId,
        at: clock.now(),
        event: eventBody(tenantId, event),
      });
    } catch (error) {
      await audited(tenantId, 'CHANNEL_SEND', `${detail} · fallido`);
      throw error;
    }
    await audited(tenantId, 'CHANNEL_SEND', `${detail} · enviado`);
  };

  const deliver = async (tenantId: string, deadline: number) => {
    let delivered = 0;
    let retrying = 0;
    let failed = 0;
    for (let count = 0; count < DELIVERY_BATCH && performance.now() < deadline; count++) {
      const now = clock.now();
      const claimed = await store.claimDue(
        tenantId,
        1,
        now,
        new Date(now.getTime() + LEASE_SECONDS * 1000),
      );
      if (!claimed.length) break;
      for (const run of claimed) {
        try {
          await execute(tenantId, run);
          await store.finishRun(tenantId, run.id, { status: 'done' }, clock.now());
          delivered++;
        } catch (error) {
          const delay = run.step ? retryDelayMinutes(run.attempts) : null;
          const at = clock.now();
          await store.finishRun(
            tenantId,
            run.id,
            delay === null
              ? { status: 'failed', error: errorText(error), retryAt: at }
              : {
                  status: 'pending',
                  error: errorText(error),
                  retryAt: new Date(at.getTime() + delay * 60_000),
                },
            at,
          );
          if (delay === null) failed++;
          else retrying++;
        }
      }
    }
    return { delivered, retrying, failed };
  };

  // No in-flight tick is shared: on Workers a tick started by another request may never settle
  // for this one. Concurrent ticks of one tenant are safe: the scan locks its cursor and runs
  // are claimed with SKIP LOCKED, so each event is queued and delivered once.
  const tickTenant = (tenantId: string): Promise<TickReport> => {
    const deadline = performance.now() + (deps.executionBudgetMs ?? 20000);
    const task = (async () => {
      const report = { tenants: 1, scanned: 0, queued: 0, delivered: 0, retrying: 0, failed: 0 };
      for (let round = 0; round < 3 && performance.now() < deadline; round++) {
        const scan = await store.scan(tenantId, SCAN_BATCH, planRuns, clock.now());
        const sent = await deliver(tenantId, deadline);
        report.scanned += scan.scanned;
        report.queued += scan.queued;
        report.delivered += sent.delivered;
        report.retrying += sent.retrying;
        report.failed += sent.failed;
        if (scan.scanned === 0 && sent.delivered === 0) break;
      }
      await deliverPush(tenantId, deadline);
      return report;
    })();
    return task;
  };

  return {
    sources: (): readonly EventSource[] => sources,

    rules: (tenantId: string) => store.rules(tenantId),

    async saveRule(
      tenantId: string,
      id: number | null,
      input: RuleInput,
      actor: string,
    ): Promise<Result<number, RuleError | 'missing' | 'duplicate'>> {
      const channels = new Set((await store.channels(tenantId)).map((c) => c.id));
      const invalid = validateRule(input, knownModules, channels);
      if (invalid) return err(invalid);
      const saved = await store.saveRule(tenantId, id, input, actor, clock.now());
      return saved.ok ? ok(saved.id) : err(saved.error);
    },

    deleteRule: (tenantId: string, id: number) => store.deleteRule(tenantId, id, clock.now()),

    channels: (tenantId: string) => store.channels(tenantId),

    async createChannel(
      tenantId: string,
      input: { kind: ChannelKind; name: string; settings: Readonly<Record<string, unknown>> },
      actor: string,
    ): Promise<Result<number, ChannelError | 'duplicate'>> {
      const valid = validateChannel(input.kind, input.settings);
      if (typeof valid === 'string') return err(valid);
      const created = await store.createChannel(
        tenantId,
        {
          kind: input.kind,
          name: input.name.trim(),
          targetHint: valid.targetHint,
          sealed: sealer.seal(JSON.stringify(valid.config)),
        },
        actor,
        clock.now(),
      );
      return created.ok ? ok(created.id) : err(created.error);
    },

    deleteChannel: (tenantId: string, id: number) => store.deleteChannel(tenantId, id, clock.now()),

    /** Sends a test message right away; the error text is returned to the administrator. */
    async testChannel(tenantId: string, id: number): Promise<Result<true, string>> {
      const config = await openChannel(tenantId, id);
      if (!config) return err('Canal no encontrado');
      const detail = `Prueba de canal ${config.kind} · canal ${id}`;
      try {
        await sender.send(config, {
          id: `msg_test_${id}_${clock.now().getTime()}`,
          title: 'Prueba de SIPGES',
          text: 'Este canal recibirá los avisos de las automatizaciones de SIPGES.',
          tenantId,
          at: clock.now(),
          event: { type: 'sipges.test', tenant: tenantId },
        });
      } catch (error) {
        await audited(tenantId, 'CHANNEL_SEND', `${detail} · fallido`);
        return err(errorText(error));
      }
      await audited(tenantId, 'CHANNEL_SEND', `${detail} · enviado`);
      return ok(true);
    },

    runs: (tenantId: string, limit: number) =>
      store.runs(tenantId, Math.min(Math.max(limit, 1), 200)),

    /**
     * Matches new audit rows and delivers due runs, for one tenant or every tenant with enabled
     * rules. Overlapping calls share the tick in progress.
     */
    tick(tenantId?: string): Promise<TickReport> {
      if (tenantId) return tickTenant(tenantId);
      return (async () => {
        const reports = await Promise.all((await store.activeTenants()).map(tickTenant));
        return reports.reduce(
          (a, b) => ({
            tenants: a.tenants + b.tenants,
            scanned: a.scanned + b.scanned,
            queued: a.queued + b.queued,
            delivered: a.delivered + b.delivered,
            retrying: a.retrying + b.retrying,
            failed: a.failed + b.failed,
          }),
          { tenants: 0, scanned: 0, queued: 0, delivered: 0, retrying: 0, failed: 0 },
        );
      })();
    },

    /** The VAPID public key browsers subscribe with, or null when push is off. */
    pushKey: (): string | null => deps.push?.sender?.publicKey ?? null,

    async pushState(username: string) {
      return {
        configured: Boolean(deps.push?.sender),
        subscriptions: ((await deps.push?.store.ownTargets?.(username)) ?? []).length,
        receipt_confirmed: false as const,
      };
    },
    /** `tenantId` is the active project, where the test is audited (no person is named). */
    async testPush(
      username: string,
      tenantId: string,
    ): Promise<{
      status: 'accepted' | 'no_subscription' | 'failed';
      accepted: number;
      detail: string;
    }> {
      const push = deps.push;
      if (!push?.sender) return { status: 'failed', accepted: 0, detail: 'Push no configurado' };
      const targets = (await push.store.ownTargets?.(username)) ?? [];
      if (!targets.length)
        return {
          status: 'no_subscription',
          accepted: 0,
          detail: 'No hay dispositivos suscritos para tu usuario',
        };
      let accepted = 0;
      let failed = false;
      for (const target of targets) {
        try {
          if (
            (await push.sender.send(
              target,
              {
                title: 'Prueba de SIPGES',
                body: 'Prueba solicitada por tu usuario. Confirma la recepción en este dispositivo.',
                url: '/',
              },
              clock.now(),
            )) === 'gone'
          ) {
            await push.store.forget(target.endpoint);
            failed = true;
          } else accepted++;
        } catch {
          failed = true;
        }
      }
      await audited(
        tenantId,
        'PUSH_SEND',
        `Prueba de push · ${accepted} aceptados · ${targets.length - accepted} fallidos`,
      );
      return {
        status: failed ? 'failed' : 'accepted',
        accepted,
        detail: failed
          ? 'Uno o más proveedores rechazaron la prueba; revisa tu suscripción'
          : 'El proveedor aceptó la prueba. La recepción en el dispositivo aún debe confirmarse.',
      };
    },
    async subscribePush(
      username: string,
      subscription: PushSubscription,
    ): Promise<Result<true, 'disabled' | 'invalid'>> {
      if (!deps.push?.sender) return err('disabled');
      if (
        !isPushEndpoint(subscription.endpoint) ||
        !/^[A-Za-z0-9_-]{80,100}$/.test(subscription.p256dh) ||
        !/^[A-Za-z0-9_-]{16,32}$/.test(subscription.auth)
      )
        return err('invalid');
      await deps.push.store.save(username, subscription, clock.now());
      return ok(true);
    },

    unsubscribePush: async (username: string, endpoint: string) => {
      await deps.push?.store.remove(username, endpoint);
    },

    inbox: (tenantId: string, username: string, limit: number) =>
      store.inbox(tenantId, username, Math.min(Math.max(limit, 1), 100)),
    markRead: (tenantId: string, username: string, ids: readonly number[] | 'all') =>
      store.markRead(tenantId, username, ids, clock.now()),
  };
};

export type AutomationService = ReturnType<typeof createAutomationService>;
