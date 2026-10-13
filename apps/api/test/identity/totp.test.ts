import { describe, expect, it } from 'vitest';
import { totp } from '../../src/contexts/identity/infrastructure/totp.ts';

// RFC 6238 Appendix B SHA-1 secret; 6-digit codes cross-checked against app.py totp_code.
const SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const at = (seconds: number) => new Date(seconds * 1000);

describe('totp.verify', () => {
  it.each([
    [59, '287082'],
    [1111111109, '081804'],
    [1234567890, '005924'],
    [2000000000, '279037'],
  ])('accepts the RFC/Python code at t=%i', (seconds, code) => {
    const result = totp.verify(SECRET, code, at(seconds), null);
    expect(result).toEqual({ ok: true, step: Math.floor(seconds / 30) });
  });

  it('accepts codes one step before and after (clock drift window, parity)', () => {
    expect(totp.verify(SECRET, '081804', at(1111111109 + 30), null).ok).toBe(true);
    expect(totp.verify(SECRET, '081804', at(1111111109 - 30), null).ok).toBe(true);
    expect(totp.verify(SECRET, '081804', at(1111111109 + 60), null).ok).toBe(false);
  });

  it.each(['', '12345', '1234567', 'abcdef', ' 081804', '081804 '])(
    'rejects malformed code %j',
    (code) => {
      expect(totp.verify(SECRET, code, at(1111111109), null).ok).toBe(false);
    },
  );

  it('rejects replay of an already used step (ADR 0004)', () => {
    const step = Math.floor(1111111109 / 30);
    expect(totp.verify(SECRET, '081804', at(1111111109), step).ok).toBe(false);
    expect(totp.verify(SECRET, '081804', at(1111111109), step - 1).ok).toBe(true);
  });
});

describe('totp.generateSecret', () => {
  it('creates an unpadded base32 secret of 20 random bytes', () => {
    const a = totp.generateSecret();
    const b = totp.generateSecret();
    expect(a).toMatch(/^[A-Z2-7]{32}$/);
    expect(a).not.toBe(b);
  });

  it('builds the same otpauth URI format as Python', () => {
    expect(totp.uri('ana.perez', SECRET)).toBe(
      `otpauth://totp/MASCLI:ana.perez?secret=${SECRET}&issuer=MASCLI&algorithm=SHA1&digits=6&period=30`,
    );
  });
});
