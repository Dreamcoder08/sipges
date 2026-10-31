import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PasswordHasher } from '../../src/contexts/identity/application/ports.ts';
import { passwordHasher } from '../../src/contexts/identity/infrastructure/password-hasher.ts';
import { portablePasswordHasher } from '../../src/contexts/identity/infrastructure/portable-password-hasher.ts';

// Produced by app.py hash_password's algorithm with a fixed salt (see L14 in the ODD log).
const LEGACY_HASH =
  'pbkdf2_sha256$310000$00112233445566778899aabbccddeeff$0a7b250afe90c4ed092f7d9d891af455aea515fa4188554efab1469e53b108f6';

const HASHERS: readonly (readonly [string, PasswordHasher])[] = [
  ['native', passwordHasher],
  ['portable', portablePasswordHasher],
];

describe.each(HASHERS)('%s passwordHasher', (_name, hasher) => {
  it('hashes new passwords with Argon2id and verifies them', async () => {
    const hash = await hasher.hash('a-strong-password');
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(await hasher.verify('a-strong-password', hash)).toBe(true);
    expect(await hasher.verify('a-wrong-password!', hash)).toBe(false);
    expect(hasher.needsRehash(hash)).toBe(false);
  });

  it('salts every hash', async () => {
    expect(await hasher.hash('same-password-1')).not.toBe(await hasher.hash('same-password-1'));
  });

  it('verifies hashes created by the Python application', async () => {
    expect(await hasher.verify('legacy-password-123', LEGACY_HASH)).toBe(true);
    expect(await hasher.verify('legacy-password-124', LEGACY_HASH)).toBe(false);
    expect(hasher.needsRehash(LEGACY_HASH)).toBe(true);
  });

  it.each([
    '',
    'garbage',
    'pbkdf2_sha256$abc$00$00',
    'md5$1$00$00',
    'pbkdf2_sha256$310000$zz$00',
    'pbkdf2_sha256$0$00112233445566778899aabbccddeeff$00',
    '$argon2id$broken',
    '$argon2i$v=19$m=19456,t=2,p=1$c2FsdHNhbHRzYWx0$aGFzaA',
    '$argon2d$v=19$m=19456,t=2,p=1$c2FsdHNhbHRzYWx0$aGFzaA',
  ])('returns false for malformed stored value %j', async (stored) => {
    expect(await hasher.verify('anything-long', stored)).toBe(false);
  });

  it('returns false, never throws, for an empty password', async () => {
    expect(await hasher.verify('', LEGACY_HASH)).toBe(false);
    expect(await hasher.verify('', await hasher.hash('a-strong-password'))).toBe(false);
  });
});

describe('native and portable hashers are interchangeable', () => {
  it('verifies each other’s Argon2id hashes, so stored passwords survive a runtime change', async () => {
    const native = await passwordHasher.hash('shared-password-1');
    const portable = await portablePasswordHasher.hash('shared-password-1');
    expect(await portablePasswordHasher.verify('shared-password-1', native)).toBe(true);
    expect(await passwordHasher.verify('shared-password-1', portable)).toBe(true);
    expect(await portablePasswordHasher.verify('shared-password-2', native)).toBe(false);
    expect(await passwordHasher.verify('shared-password-2', portable)).toBe(false);
  });
});

describe('portable hasher on Cloudflare Workers', () => {
  afterEach(() => vi.restoreAllMocks());

  it('hashes and verifies with WebAssembly compilation disabled, as workerd does', async () => {
    const native = await passwordHasher.hash('workerd-password-1');
    // The API compiles without DOM types, so reach the runtime's WebAssembly through globalThis.
    const wasm = (globalThis as unknown as { WebAssembly: Record<string, () => unknown> })
      .WebAssembly;
    const disabled = () => {
      throw new Error('Wasm code generation disallowed by embedder');
    };
    for (const entry of ['compile', 'instantiate', 'Module'])
      vi.spyOn(wasm, entry).mockImplementation(disabled);
    const hash = await portablePasswordHasher.hash('workerd-password-1');
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(await portablePasswordHasher.verify('workerd-password-1', hash)).toBe(true);
    expect(await portablePasswordHasher.verify('workerd-password-1', native)).toBe(true);
    expect(await portablePasswordHasher.verify('legacy-password-123', LEGACY_HASH)).toBe(true);
  });

  it.each([
    '$argon2id$v=19$m=4194304,t=2,p=1$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaA',
    '$argon2id$v=19$m=19456,t=1000,p=1$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaA',
    '$argon2id$v=19$m=19456,t=2,p=64$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaA',
    '$argon2id$v=16$m=19456,t=2,p=1$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaA',
    'pbkdf2_sha256$9999999$00112233445566778899aabbccddeeff$00',
  ])('refuses stored costs beyond the Worker budget: %j', async (stored) => {
    // portable-password-hasher-budget.test.ts proves that nothing is computed for these.
    expect(await portablePasswordHasher.verify('anything-long', stored)).toBe(false);
  });
});
