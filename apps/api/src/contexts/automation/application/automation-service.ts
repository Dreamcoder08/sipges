import { type Result, err, ok } from '@mascli/kernel';
import {
  type ChannelConfig,
  type ChannelError,
  type ChannelKind,
  validateChannel,
} from '../domain/channels.ts';
import {
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
  SecretSealer,
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
  type: `mascli.${event.module.toLowerCase()}.${event.action.toLowerCase()}`,
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
  store: AutomationStore;
  sender: ChannelSender;
  sealer: SecretSealer;
  clock: Clock;
  /** Stored names of the records modules, which are event sources too. */
  recordModules: readonly string[];
}) => {
  const { store, sender, sealer, clock } = deps;
  const sources: EventSource[] = [
    ...deps.recordModules.map((module) => ({ module, label: module.replaceAll('_', ' ') })),
    ...SYSTEM_EVENT_SOURCES,
  ];
  const knownModules = new Set(sources.map((s) => s.module));

  const openChannel = async (tenantId: string, id: number): Promise<ChannelConfig | null> => {
    const sealed = await store.sealedChannel(tenantId, id);
    return sealed ? (JSON.parse(sealer.open(sealed)) as ChannelConfig) : null;
  };

  const execute = async (tenantId: string, run: ClaimedRun): Promise<void> => {
    const { step, event } = run;
    if (!step) throw new Error('La regla ya no tiene esta acción');
    const title = renderTitle(step.title, event);
    const text = describeEvent(event);
    if (step.kind === 'notify') {
      await store.notify(
        tenantId,
        {
          title,
          body: text,
          module: event.module,
          recordId: event.recordId,
          marking: event.record?.marking ?? 'interno',
          ruleId: run.ruleId,
        },
        clock.now(),
      );
      return;
    }
    const config = await openChannel(tenantId, step.channelId);
    if (!config) throw new Error('El canal ya no existe');
    await sender.send(config, {
      id: `msg_${tenantId.replace(/[^A-Za-z0-9]/g, '_')}_${run.id}`,
      title,
      text,
      tenantId,
      at: clock.now(),
      event: eventBody(tenantId, event),
    });
  };

  const deliver = async (tenantId: string) => {
    const now = clock.now();
    const claimed = await store.claimDue(
      tenantId,
      DELIVERY_BATCH,
      now,
      new Date(now.getTime() + LEASE_SECONDS * 1000),
    );
    let delivered = 0;
    let retrying = 0;
    let failed = 0;
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
    return { delivered, retrying, failed };
  };

  let ticking: Promise<TickReport> | null = null;

  const tickAll = async (tenantIds: readonly string[]): Promise<TickReport> => {
    const report = { tenants: 0, scanned: 0, queued: 0, delivered: 0, retrying: 0, failed: 0 };
    for (const tenantId of tenantIds) {
      const scan = await store.scan(tenantId, SCAN_BATCH, planRuns, clock.now());
      const sent = await deliver(tenantId);
      report.tenants++;
      report.scanned += scan.scanned;
      report.queued += scan.queued;
      report.delivered += sent.delivered;
      report.retrying += sent.retrying;
      report.failed += sent.failed;
    }
    return report;
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
      try {
        await sender.send(config, {
          id: `msg_test_${id}_${clock.now().getTime()}`,
          title: 'Prueba de MASCLI',
          text: 'Este canal recibirá los avisos de las automatizaciones de MASCLI.',
          tenantId,
          at: clock.now(),
          event: { type: 'mascli.test', tenant: tenantId },
        });
        return ok(true);
      } catch (error) {
        return err(errorText(error));
      }
    },

    runs: (tenantId: string, limit: number) =>
      store.runs(tenantId, Math.min(Math.max(limit, 1), 200)),

    /**
     * Matches new audit rows and delivers due runs, for one tenant or every tenant with enabled
     * rules. Overlapping calls share the tick in progress.
     */
    tick(tenantId?: string): Promise<TickReport> {
      if (ticking) return ticking;
      ticking = (async () =>
        tickAll(tenantId ? [tenantId] : await store.activeTenants()))().finally(() => {
        ticking = null;
      });
      return ticking;
    },

    notifications: (tenantId: string, username: string, limit: number) =>
      store.notifications(tenantId, username, Math.min(Math.max(limit, 1), 100)),
    unread: (tenantId: string, username: string) => store.unread(tenantId, username),
    markRead: (tenantId: string, username: string, ids: readonly number[] | 'all') =>
      store.markRead(tenantId, username, ids, clock.now()),
  };
};

export type AutomationService = ReturnType<typeof createAutomationService>;
