import { describe, expect, it } from 'vitest';
import {
  createAutomationRuntime,
  type RuntimeStore,
} from '../../src/contexts/system/application/index.ts';
const report = { tenants: 1, scanned: 2, queued: 1, delivered: 1, retrying: 0, failed: 0 };
const setup = () => {
  const calls: string[] = [];
  const store: RuntimeStore = {
    dueTenants: async () => ['A/project', 'B/project'],
    start: async (tenant, _token, source) => {
      calls.push(`start:${tenant}:${source}`);
    },
    finish: async (tenant, _token, outcome) => {
      calls.push(`finish:${tenant}:${outcome.status}`);
    },
    state: async (tenant) => {
      calls.push(`state:${tenant}`);
      return null;
    },
  };
  return { store, calls, clock: { now: () => new Date('2026-10-17T12:00:00Z') } };
};
describe('automation runtime', () => {
  it('coalesces a project without suppressing another project', async () => {
    const f = setup();
    const releases: (() => void)[] = [];
    const runtime = createAutomationRuntime({
      ...f,
      tick: async () => {
        await new Promise<void>((r) => releases.push(r));
        return report;
      },
    });
    const a = runtime.run('A/project', 'event'),
      again = runtime.run('A/project', 'event'),
      b = runtime.run('B/project', 'event');
    await new Promise((r) => setImmediate(r));
    expect(releases).toHaveLength(2);
    releases.forEach((r) => r());
    expect(await a).toEqual(report);
    expect(await again).toEqual(report);
    expect(await b).toEqual(report);
    expect(f.calls.filter((x) => x.startsWith('start'))).toHaveLength(2);
  });
  it('registers deferred work and records failures without rejecting committed writes', async () => {
    const f = setup(),
      pending: Promise<unknown>[] = [],
      errors: string[] = [];
    const runtime = createAutomationRuntime({
      ...f,
      tick: async () => {
        throw new Error('provider unavailable');
      },
      onError: () => errors.push('failed'),
    });
    await runtime.dispatch('A/project', (task) => pending.push(task));
    await Promise.all(pending);
    expect(f.calls).toEqual(['start:A/project:event', 'finish:A/project:failed']);
    expect(errors).toEqual(['failed']);
  });
  it('stops at the scheduled budget boundary', async () => {
    const f = setup();
    let elapsed = 0;
    const runtime = createAutomationRuntime({
      ...f,
      budgetMs: 20000,
      monotonicNow: () => elapsed,
      tick: async () => {
        elapsed = 21000;
        return report;
      },
    });
    expect(await runtime.scheduled()).toEqual(report);
    expect(f.calls).not.toContain('start:B/project:cron');
  });
  it('attempts another scope but rejects partial cron success', async () => {
    const f = setup();
    const runtime = createAutomationRuntime({
      ...f,
      tick: async (tenant) => {
        if (tenant === 'A/project') throw new Error('failure');
        return report;
      },
    });
    await expect(runtime.scheduled()).rejects.toBeInstanceOf(AggregateError);
    expect(f.calls).toContain('finish:A/project:failed');
    expect(f.calls).toContain('finish:B/project:completed');
  });
  it('reads evidence only for the requested scope', async () => {
    const f = setup();
    const runtime = createAutomationRuntime({ ...f, tick: async () => report });
    expect(await runtime.state('A/project')).toBeNull();
    expect(f.calls).toEqual(['state:A/project']);
  });
  it('collects configured sources before scanning committed source events', async () => {
    const f = setup(),
      order: string[] = [];
    const runtime = createAutomationRuntime({
      ...f,
      beforeTick: async (_tenant, source) => {
        order.push(`collect:${source}`);
      },
      tick: async () => {
        order.push('tick');
        return report;
      },
    });
    await runtime.run('A/project', 'cron');
    expect(order).toEqual(['collect:cron', 'tick']);
  });
  it('source outages cannot block pending delivery and remain failed attempts', async () => {
    const f = setup();
    let delivered = false;
    const runtime = createAutomationRuntime({
      ...f,
      beforeTick: async () => {
        throw new Error('source unavailable');
      },
      tick: async () => {
        delivered = true;
        return report;
      },
    });
    await expect(runtime.run('A/project', 'cron')).rejects.toThrow('source unavailable');
    expect(delivered).toBe(true);
    expect(f.calls).toContain('finish:A/project:failed');
  });
  it('keeps committed work alive if a deferred adapter is unavailable', async () => {
    const f = setup();
    let delivered = false;
    const runtime = createAutomationRuntime({
      ...f,
      tick: async () => {
        delivered = true;
        return report;
      },
    });
    await runtime.dispatch('A/project', () => {
      throw new Error('no context');
    });
    expect(delivered).toBe(true);
    expect(f.calls).toContain('finish:A/project:completed');
  });
});
