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
  const inFlight = new Map<string, Promise<TickReport>>();
  const now = deps.monotonicNow ?? (() => performance.now());
  const run = (tenantId: string, source: RuntimeSource): Promise<TickReport> => {
    const pending = inFlight.get(tenantId);
    if (pending) return pending;
    const token = randomUUID();
    const task = (async () => {
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
    })().finally(() => inFlight.delete(tenantId));
    inFlight.set(tenantId, task);
    return task;
  };
  return {
    run,
    state: (tenantId: string) => deps.store.state(tenantId),
    async dispatch(tenantId: string, defer?: (task: Promise<unknown>) => void) {
      // A later committed write needs a fresh scan after the current worker finishes.
      const previous = inFlight.get(tenantId);
      const task = (
        previous
          ? previous.catch(() => undefined).then(() => run(tenantId, 'event'))
          : run(tenantId, 'event')
      ).catch((error) => {
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
