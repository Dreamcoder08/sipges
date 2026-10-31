import { pbkdf2Sync } from 'node:crypto';
import type * as Argon2 from '@noble/hashes/argon2.js';
import { argon2id } from '@noble/hashes/argon2.js';
import type * as Pbkdf2 from '@noble/hashes/pbkdf2.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Wrap the real primitives so each test can tell whether the hasher computed anything.
const calls = vi.hoisted(() => ({ argon2: 0, pbkdf2: 0 }));
vi.mock('@noble/hashes/argon2.js', async (importOriginal) => {
  const original = await importOriginal<typeof Argon2>();
  return {
    ...original,
    argon2idAsync: (...args: Parameters<typeof original.argon2idAsync>) => {
      calls.argon2++;
      return original.argon2idAsync(...args);
    },
  };
});
vi.mock('@noble/hashes/pbkdf2.js', async (importOriginal) => {
  const original = await importOriginal<typeof Pbkdf2>();
  return {
    ...original,
    pbkdf2Async: (...args: Parameters<typeof original.pbkdf2Async>) => {
      calls.pbkdf2++;
      return original.pbkdf2Async(...args);
    },
  };
});

const { portablePasswordHasher } =
  await import('../../src/contexts/identity/infrastructure/portable-password-hasher.ts');

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64').replace(/=+$/, '');
const SALT = new Uint8Array(16).fill(7);
const phc = (m: number, t: number, p: number, password: string) =>
  `$argon2id$v=19$m=${m},t=${t},p=${p}$${b64(SALT)}$${b64(argon2id(password, SALT, { m, t, p, dkLen: 32 }))}`;

beforeEach(() => {
  calls.argon2 = 0;
  calls.pbkdf2 = 0;
});

describe('portable hasher cost budget', () => {
  it.each([
    '$argon2id$v=19$m=65537,t=2,p=1$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaA',
    '$argon2id$v=19$m=19456,t=11,p=1$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaA',
    '$argon2id$v=19$m=19456,t=2,p=5$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaA',
    'pbkdf2_sha256$1000001$00112233445566778899aabbccddeeff$00',
  ])('refuses %j without computing anything', async (stored) => {
    expect(await portablePasswordHasher.verify('anything-long', stored)).toBe(false);
    expect(calls).toEqual({ argon2: 0, pbkdf2: 0 });
  });

  it('still computes and accepts a hash exactly at the Argon2 limits', async () => {
    const stored = phc(65536, 1, 1, 'boundary-password');
    expect(await portablePasswordHasher.verify('boundary-password', stored)).toBe(true);
    expect(await portablePasswordHasher.verify('boundary-passworx', stored)).toBe(false);
    expect(calls.argon2).toBe(2);
  });

  it('still computes and accepts a legacy hash exactly at the PBKDF2 limit', async () => {
    const salt = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
    const digest = pbkdf2Sync('legacy-boundary', salt, 1_000_000, 32, 'sha256').toString('hex');
    const stored = `pbkdf2_sha256$1000000$${salt.toString('hex')}$${digest}`;
    expect(await portablePasswordHasher.verify('legacy-boundary', stored)).toBe(true);
    expect(calls.pbkdf2).toBe(1);
  });
});

describe('portable hasher PHC parsing', () => {
  const valid = phc(19456, 2, 1, 'parse-password');
  const [, , version, params, salt, digest] = valid.split('$');

  it('encodes salt and digest as unpadded standard base64 of 16 and 32 bytes', async () => {
    const hash = await portablePasswordHasher.hash('encoding-password');
    const [, , , , saltPart, digestPart] = hash.split('$');
    expect(saltPart).toMatch(/^[A-Za-z0-9+/]{22}$/);
    expect(digestPart).toMatch(/^[A-Za-z0-9+/]{43}$/);
  });

  it.each([
    ['bad base64 in the salt', `$argon2id$${version}$${params}$!!!!$${digest}`],
    ['bad base64 in the digest', `$argon2id$${version}$${params}$${salt}$!!!!`],
    ['a padded digest', `$argon2id$${version}$${params}$${salt}$${digest}=`],
    ['a 6-byte salt', `$argon2id$${version}$${params}$AAAAAAAA$${digest}`],
    ['an 8-byte digest', `$argon2id$${version}$${params}$${salt}$AAAAAAAAAAA`],
  ])('returns false for %s without computing', async (_label, stored) => {
    expect(await portablePasswordHasher.verify('parse-password', stored)).toBe(false);
    expect(calls.argon2).toBe(0);
  });
});
