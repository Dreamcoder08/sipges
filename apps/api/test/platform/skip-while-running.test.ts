import { describe, expect, it, vi } from 'vitest';
import { skipWhileRunning } from '../../src/platform/skip-while-running.ts';

const deferred = () => {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('skipWhileRunning (Node automation interval)', () => {
  it('skips a trigger while the previous run is still in flight instead of queuing it', async () => {
    const first = deferred();
    const task = vi.fn(() => first.promise);
    const onSkip = vi.fn();
    const trigger = skipWhileRunning(task, { onError: vi.fn(), onSkip });

    expect(trigger()).toBe(true);
    expect(trigger()).toBe(false);
    expect(trigger()).toBe(false);

    expect(task).toHaveBeenCalledTimes(1);
    expect(onSkip).toHaveBeenCalledTimes(2);

    first.resolve();
    await flush();
    expect(task).toHaveBeenCalledTimes(1);
  });

  it('tells a skip how long the previous run has been in flight, so a hung run is visible', async () => {
    const first = deferred();
    let now = 1_000;
    const onSkip = vi.fn();
    const trigger = skipWhileRunning(() => first.promise, {
      onError: vi.fn(),
      onSkip,
      now: () => now,
    });

    trigger();
    now = 61_000;
    trigger();
    now = 121_000;
    trigger();

    expect(onSkip.mock.calls).toEqual([[60_000], [120_000]]);
    first.resolve();
    await flush();
  });

  it('runs again on the next trigger once the previous run has settled', async () => {
    const task = vi.fn(() => Promise.resolve());
    const trigger = skipWhileRunning(task, { onError: vi.fn() });

    expect(trigger()).toBe(true);
    await flush();
    expect(trigger()).toBe(true);
    expect(task).toHaveBeenCalledTimes(2);
  });

  it('reports a failed run and still lets the next trigger run', async () => {
    const failure = new Error('tick failed');
    const first = deferred();
    const task = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(undefined);
    const onError = vi.fn();
    const trigger = skipWhileRunning(task, { onError });

    trigger();
    first.reject(failure);
    await flush();

    expect(onError).toHaveBeenCalledExactlyOnceWith(failure);
    expect(trigger()).toBe(true);
    expect(task).toHaveBeenCalledTimes(2);
  });

  it('reports a task that throws synchronously and does not stay locked', async () => {
    const failure = new Error('sync throw');
    const task = vi
      .fn<() => Promise<void>>()
      .mockImplementationOnce(() => {
        throw failure;
      })
      .mockResolvedValue(undefined);
    const onError = vi.fn();
    const trigger = skipWhileRunning(task, { onError });

    expect(trigger()).toBe(true);
    await flush();

    expect(onError).toHaveBeenCalledExactlyOnceWith(failure);
    expect(trigger()).toBe(true);
  });
});
