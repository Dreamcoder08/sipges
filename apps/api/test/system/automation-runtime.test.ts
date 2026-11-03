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
  it('runs its own tick for a project already ticking and never waits on the other', async () => {
    // On Workers a tick started by a cancelled request never settles for another request;
    // the database serializes concurrent scans of one project.
    const f = setup();
    let calls = 0;
    const runtime = createAutomationRuntime({
      ...f,
      tick: async () => {
        calls += 1;
        if (calls === 1) await new Promise<void>(() => {});
        return report;
      },
    });
    void runtime.run('A/project', 'event');
    const again = await Promise.race([
      runtime.run('A/project', 'cron'),
      new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 500)),
    ]);
    expect(again).toEqual(report);
    expect(await runtime.run('B/project', 'event')).toEqual(report);
    expect(f.calls.filter((x) => x.startsWith('start'))).toEqual([
      'start:A/project:event',
      'start:A/project:cron',
      'start:B/project:event',
    ]);
  });
  it('turns writes during a running tick into one more scan instead of waiting', async () => {
    const f = setup();
    let release: (() => void) | undefined;
    let ticks = 0;
    const runtime = createAutomationRuntime({
      ...f,
      tick: async () => {
        ticks += 1;
        if (ticks === 1) await new Promise<void>((r) => (release = r));
        return report;
      },
    });
    const pending: Promise<unknown>[] = [];
    await runtime.dispatch('A/project', (task) => pending.push(task));
    await new Promise((r) => setImmediate(r));
    // Two writes while the first tick runs: neither waits on it, and they share one rescan.
    const deferredByLaterWrites: Promise<unknown>[] = [];
    await runtime.dispatch('A/project', (task) => deferredByLaterWrites.push(task));
    await runtime.dispatch('A/project', (task) => deferredByLaterWrites.push(task));
    await Promise.all(deferredByLaterWrites);
    release?.();
    await Promise.all(pending);
    expect(ticks).toBe(2);
  });
  it('still rescans for a write that arrived while the running tick failed', async () => {
    const f = setup();
    let fail: ((error: Error) => void) | undefined;
    let ticks = 0;
    const runtime = createAutomationRuntime({
      ...f,
      tick: async () => {
        ticks += 1;
        if (ticks === 1) await new Promise<void>((_, reject) => (fail = reject));
        return report;
      },
      onError: () => undefined,
    });
    const pending: Promise<unknown>[] = [];
    await runtime.dispatch('A/project', (task) => pending.push(task));
    await new Promise((r) => setImmediate(r));
    await runtime.dispatch('A/project', () => undefined);
    fail?.(new Error('provider unavailable'));
    await Promise.all(pending);
    expect(ticks).toBe(2);
    expect(f.calls).toEqual([
      'start:A/project:event',
      'finish:A/project:failed',
      'start:A/project:event',
      'finish:A/project:completed',
    ]);
  });
  it('starts a fresh tick when the running one outlived its budget', async () => {
    // On Workers a tick whose request was cancelled never ends; later writes must not wait for it.
    const f = setup();
    let elapsed = 0;
    let ticks = 0;
    const runtime = createAutomationRuntime({
      ...f,
      budgetMs: 20000,
      monotonicNow: () => elapsed,
      tick: async () => {
        ticks += 1;
        if (ticks === 1) await new Promise<void>(() => {});
        return report;
      },
    });
    await runtime.dispatch('A/project', () => undefined);
    await new Promise((r) => setImmediate(r));
    elapsed = 20001;
    const pending: Promise<unknown>[] = [];
    await runtime.dispatch('A/project', (task) => pending.push(task));
    await Promise.all(pending);
    expect(ticks).toBe(2);
  });
  it('bounds the rescans one tick owes to writes that keep arriving', async () => {
    const f = setup();
    let ticks = 0;
    const runtime = createAutomationRuntime({
      ...f,
      tick: async () => {
        ticks += 1;
        // Every scan sees one more write arrive meanwhile.
        await runtime.dispatch('A/project', () => undefined);
        return report;
      },
    });
    const pending: Promise<unknown>[] = [];
    await runtime.dispatch('A/project', (task) => pending.push(task));
    await Promise.all(pending);
    expect(ticks).toBe(3);
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
