import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createSecretCipher } from '../../src/contexts/identity/infrastructure/secret-cipher.ts';

const key = randomBytes(32);

describe('secret cipher (AES-256-GCM)', () => {
  it('round-trips and never stores the plaintext', () => {
    const cipher = createSecretCipher(key);
    const sealed = cipher.seal('GEZDGNBVGY3TQOJQ');
    expect(sealed).toMatch(/^v1\./);
    expect(sealed).not.toContain('GEZDGNBVGY3TQOJQ');
    expect(cipher.open(sealed)).toBe('GEZDGNBVGY3TQOJQ');
  });

  it('uses a fresh nonce for every seal', () => {
    const cipher = createSecretCipher(key);
    expect(cipher.seal('same')).not.toBe(cipher.seal('same'));
  });

  it('rejects tampered ciphertext and the wrong key', () => {
    const cipher = createSecretCipher(key);
    const sealed = cipher.seal('secret');
    // Flip a decoded byte: editing a base64 character can touch only padding bits and be a no-op.
    const raw = Buffer.from(sealed.slice(3), 'base64url');
    for (const index of [0, 12, raw.length - 1]) {
      const tampered = Buffer.from(raw);
      tampered[index] = (tampered[index] ?? 0) ^ 0x01;
      expect(() => cipher.open(`v1.${tampered.toString('base64url')}`)).toThrow();
    }
    expect(() => createSecretCipher(randomBytes(32)).open(sealed)).toThrow();
  });

  it('opens values sealed with a previous key and seals only with the current one', () => {
    const previous = randomBytes(32);
    const old = createSecretCipher(previous).seal('rotating');
    const staged = createSecretCipher(key, [previous]);
    expect(staged.open(old)).toBe('rotating');
    const fresh = staged.seal('rotating');
    expect(createSecretCipher(key).open(fresh)).toBe('rotating');
    expect(() => createSecretCipher(previous).open(fresh)).toThrow();
    expect(() => staged.open(createSecretCipher(randomBytes(32)).seal('other'))).toThrow();
  });

  it('requires a 32-byte key', () => {
    expect(() => createSecretCipher(randomBytes(16))).toThrow(
      'SIPGES_DATA_KEY must decode to 32 bytes',
    );
  });
});
