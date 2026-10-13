import { describe, expect, it } from 'vitest';
import { THROTTLE, throttleDecision } from '../../src/contexts/identity/domain/login-throttle.ts';

describe('throttleDecision', () => {
  it('allows attempts below both limits', () => {
    expect(throttleDecision({ userFailures: THROTTLE.maxPerUser - 1, ipFailures: 0 })).toEqual({
      allowed: true,
    });
  });

  it('blocks a username that reached its failure limit within the window', () => {
    expect(throttleDecision({ userFailures: THROTTLE.maxPerUser, ipFailures: 0 })).toEqual({
      allowed: false,
      retryAfterSeconds: THROTTLE.windowSeconds,
    });
  });

  it('blocks an address that reached its failure limit within the window', () => {
    expect(throttleDecision({ userFailures: 0, ipFailures: THROTTLE.maxPerIp })).toEqual({
      allowed: false,
      retryAfterSeconds: THROTTLE.windowSeconds,
    });
  });

  it('uses OWASP-style conservative limits', () => {
    expect(THROTTLE).toEqual({ maxPerUser: 5, maxPerIp: 20, windowSeconds: 900 });
  });
});
