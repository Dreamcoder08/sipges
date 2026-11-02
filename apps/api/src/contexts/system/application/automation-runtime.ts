import { randomUUID } from 'node:crypto';
import type { TickReport } from '../../automation/application/index.ts';
export type RuntimeSource = 'event' | 'cron';
export type RuntimeAttempt = {
  startedAt: Date;
  finishedAt: Date | null;
  source: RuntimeSource;
  status: 'running' | 'completed' | 'failed';
  report: TickReport | null;
  error: string;
};
export type RuntimeStore = {
  dueTenants(limit: number): Promise<string[]>;
  start(tenantId: string, token: string, source: RuntimeSource, at: Date): Promise<void>;
  finish(
    tenantId: string,
    token: string,
    outcome: { status: 'completed' | 'failed'; report: TickReport | null; error: string },
    at: Date,
  ): Promise<void>;
  state(tenantId: string): Promise<RuntimeAttempt | null>;
};
const emptyReport = (): TickReport => ({
  tenants: 0,
  scanned: 0,
  queued: 0,
  delivered: 0,
  retrying: 0,
  failed: 0,
});
/** Bounded durable worker coordination; evidence describes attempts, never a latency SLA. */
export const createAutomationRuntime = (deps: {
  store: RuntimeStore;
  tick(tenantId: string): Promise<TickReport>;
  beforeTick?: (tenantId: string, source: RuntimeSource) => Promise<void>;
  clock: { now(): Date };
  monotonicNow?: () => number;
  budgetMs?: number;
  onError?: (error: unknown) => void;
}) => {
  // Ticks running in this isolate. Nothing ever awaits another request's tick: on Workers it
  // may never settle for a different request. The database serializes concurrent scans.
  const running = new Map<string, { rescan: boolean }>();
  const now = deps.monotonicNow ?? (() => performance.now());
  const attempt = async (tenantId: string, source: RuntimeSource): Promise<TickReport> => {
    const token = randomUUID();
    await deps.store.start(tenantId, token, source, deps.clock.now());
    try {
      let preparationError: unknown;
      try {
        await deps.beforeTick?.(tenantId, source);
      } catch (error) {
        preparationError = error;
      }
      const report = await deps.tick(tenantId);
      if (preparationError) throw preparationError;
      await deps.store.finish(
        tenantId,
        token,
        { status: 'completed', report, error: '' },
        deps.clock.now(),
      );
      return report;
    } catch (error) {
      await deps.store.finish(
        tenantId,
        token,
        { status: 'failed', report: null, error: 'processing_failed' },
        deps.clock.now(),
      );
      throw error;
    }
  };
  /** A tick of its own; writes that arrive meanwhile ask for one more scan when it ends. */
  const run = async (tenantId: string, source: RuntimeSource): Promise<TickReport> => {
    if (running.has(tenantId)) return attempt(tenantId, source);
    const state = { rescan: false };
    running.set(tenantId, state);
    try {
      let next = source;
      let outcome: { ok: true; report: TickReport } | { ok: false; error: unknown };
      do {
        state.rescan = false;
        try {
          outcome = { ok: true, report: await attempt(tenantId, next) };
        } catch (error) {
          // A failed tick still owes the rescan that a later write asked for.
          outcome = { ok: false, error };
        }
        next = 'event';
      } while (state.rescan);
      if (!outcome.ok) throw outcome.error;
      return outcome.report;
    } finally {
      running.delete(tenantId);
    }
  };
  return {
    run,
    state: (tenantId: string) => deps.store.state(tenantId),
    async dispatch(tenantId: string, defer?: (task: Promise<unknown>) => void) {
      // A committed write needs a scan after it. A tick already running here will rescan.
      const current = running.get(tenantId);
      if (current) {
        current.rescan = true;
        return;
      }
      const task = run(tenantId, 'event').catch((error) => {
        deps.onError?.(error);
      });
      if (defer) {
        try {
          defer(task);
        } catch {
          await task;
        }
      } else await task;
    },
    async scheduled(): Promise<TickReport> {
      const deadline = now() + (deps.budgetMs ?? 20000);
      const total = emptyReport();
      const errors: unknown[] = [];
      for (const tenantId of await deps.store.dueTenants(100)) {
        if (now() >= deadline) break;
        try {
          const report = await run(tenantId, 'cron');
          for (const key of Object.keys(total) as (keyof TickReport)[])
            (total as { -readonly [K in keyof TickReport]: number })[key] += report[key];
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length)
        throw new AggregateError(errors, 'Uno o más proyectos no completaron su procesamiento');
      return total;
    },
  };
};
export type AutomationRuntime = ReturnType<typeof createAutomationRuntime>;
