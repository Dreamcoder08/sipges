import type * as Argon2 from '@noble/hashes/argon2.js';
import { argon2id } from '@noble/hashes/argon2.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Wrap the real primitive to track how many Argon2id computations are in flight at once.
const state = vi.hoisted(() => ({
  inFlight: 0,
  peak: 0,
  started: 0,
  failNext: 0,
  order: [] as string[],
}));
vi.mock('@noble/hashes/argon2.js', async (importOriginal) => {
  const original = await importOriginal<typeof Argon2>();
  return {
    ...original,
    argon2idAsync: async (...args: Parameters<typeof original.argon2idAsync>) => {
      state.started++;
      state.order.push(String(args[0]));
      state.inFlight++;
      state.peak = Math.max(state.peak, state.inFlight);
      try {
        // Yield so concurrent callers can overlap even though the cost below is tiny.
        await new Promise((resolve) => setTimeout(resolve, 5));
        if (state.failNext > 0) {
          state.failNext--;
          throw new Error('simulated Argon2id failure');
        }
        return await original.argon2idAsync(...args);
      } finally {
        state.inFlight--;
      }
    },
  };
});

const { portablePasswordHasher } =
  await import('../../src/contexts/identity/infrastructure/portable-password-hasher.ts');

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64').replace(/=+$/, '');
const SALT = new Uint8Array(16).fill(9);
const phc = (password: string) =>
  `$argon2id$v=19$m=8,t=1,p=1$${b64(SALT)}$${b64(argon2id(password, SALT, { m: 8, t: 1, p: 1, dkLen: 32 }))}`;

beforeEach(() => {
  Object.assign(state, { inFlight: 0, peak: 0, started: 0, failNext: 0, order: [] });
});

describe('portable hasher Argon2id concurrency gate', () => {
  it('runs at most 2 computations at once and still answers every verification correctly', async () => {
    const stored = phc('gate-password-one');
    const attempts = [
      'gate-password-one',
      'wrong-password-a',
      'gate-password-one',
      'wrong-password-b',
      'gate-password-one',
    ];

    const results = await Promise.all(
      attempts.map((attempt) => portablePasswordHasher.verify(attempt, stored)),
    );

    expect(results).toEqual([true, false, true, false, true]);
    expect(state.started).toBe(5);
    expect(state.peak).toBe(2);
  });

  it('shares the gate between hash and verify', async () => {
    const stored = phc('gate-password-two');

    const [first, second, third, fourth] = await Promise.all([
      portablePasswordHasher.hash('gate-password-two'),
      portablePasswordHasher.verify('gate-password-two', stored),
      portablePasswordHasher.hash('gate-password-three'),
      portablePasswordHasher.verify('gate-password-two', stored),
    ]);

    expect(first.startsWith('$argon2id$')).toBe(true);
    expect(second).toBe(true);
    expect(third.startsWith('$argon2id$')).toBe(true);
    expect(fourth).toBe(true);
    expect(state.peak).toBe(2);
  });

  it('releases the slot when a computation throws', async () => {
    const stored = phc('gate-password-four');
    state.failNext = 2;

    const results = await Promise.all(
      Array.from({ length: 5 }, () => portablePasswordHasher.verify('gate-password-four', stored)),
    );

    // The first two fail (verify reports false), the three queued behind them still complete.
    expect(results).toEqual([false, false, true, true, true]);
    expect(state.started).toBe(5);
    expect(state.inFlight).toBe(0);
    expect(state.peak).toBe(2);
    expect(await portablePasswordHasher.verify('gate-password-four', stored)).toBe(true);
  });

  it('starts queued computations in arrival order', async () => {
    const passwords = Array.from({ length: 5 }, (_, index) => `fifo-password-${index}`);

    const results = await Promise.all(
      passwords.map((password) => portablePasswordHasher.verify(password, phc(password))),
    );

    expect(results).toEqual([true, true, true, true, true]);
    // The first two take the free slots at once; the other three wait and must start in call order.
    expect(state.order.slice(2)).toEqual(passwords.slice(2));
    expect(state.order.slice(0, 2).sort()).toEqual(passwords.slice(0, 2));
  });

  it('logs a failed computation by error class only, but not a malformed stored hash', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      state.failNext = 1;
      expect(
        await portablePasswordHasher.verify('gate-password-five', phc('gate-password-five')),
      ).toBe(false);
      expect(log).toHaveBeenCalledTimes(1);
      expect(log).toHaveBeenCalledWith('MASCLI password verification failed', { kind: 'Error' });
      expect(JSON.stringify(log.mock.calls)).not.toContain('gate-password-five');

      log.mockClear();
      expect(await portablePasswordHasher.verify('gate-password-five', '$argon2id$broken')).toBe(
        false,
      );
      expect(log).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });
});
