import { describe, expect, it } from 'vitest';
import { err, isErr, isOk, map, ok } from './result.ts';

describe('Result', () => {
  it('wraps a success value', () => {
    const result = ok(42);
    expect(isOk(result)).toBe(true);
    expect(isErr(result)).toBe(false);
    expect(result).toEqual({ ok: true, value: 42 });
  });

  it('wraps an expected failure', () => {
    const result = err({ code: 'not_found' as const });
    expect(isErr(result)).toBe(true);
    expect(result).toEqual({ ok: false, error: { code: 'not_found' } });
  });

  it('maps only successful values', () => {
    expect(map(ok(2), (n) => n * 3)).toEqual(ok(6));
    const failure = err('boom');
    expect(map(failure, (n: number) => n * 3)).toBe(failure);
  });
});
