import { describe, expect, it } from 'vitest';
import { passwordHasher } from '../../src/contexts/identity/infrastructure/password-hasher.ts';

// Produced by app.py hash_password's algorithm with a fixed salt (see L14 in the ODD log).
const LEGACY_HASH =
  'pbkdf2_sha256$310000$00112233445566778899aabbccddeeff$0a7b250afe90c4ed092f7d9d891af455aea515fa4188554efab1469e53b108f6';

describe('passwordHasher', () => {
  it('hashes new passwords with Argon2id and verifies them', async () => {
    const hash = await passwordHasher.hash('a-strong-password');
    expect(hash).toMatch(/^\$argon2id\$/);
    expect(await passwordHasher.verify('a-strong-password', hash)).toBe(true);
    expect(await passwordHasher.verify('a-wrong-password!', hash)).toBe(false);
    expect(passwordHasher.needsRehash(hash)).toBe(false);
  });

  it('verifies hashes created by the Python application', async () => {
    expect(await passwordHasher.verify('legacy-password-123', LEGACY_HASH)).toBe(true);
    expect(await passwordHasher.verify('legacy-password-124', LEGACY_HASH)).toBe(false);
    expect(passwordHasher.needsRehash(LEGACY_HASH)).toBe(true);
  });

  it.each([
    '',
    'garbage',
    'pbkdf2_sha256$abc$00$00',
    'md5$1$00$00',
    'pbkdf2_sha256$310000$zz$00',
    '$argon2id$broken',
  ])('returns false for malformed stored value %j', async (stored) => {
    expect(await passwordHasher.verify('anything-long', stored)).toBe(false);
  });
});
