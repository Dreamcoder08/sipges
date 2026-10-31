import { pbkdf2, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { hash, verify } from '@node-rs/argon2';
import type { PasswordHasher } from '../application/ports.ts';
import { parseLegacyHash } from './legacy-hash.ts';

const pbkdf2Async = promisify(pbkdf2);

// `Algorithm` is an ambient const enum (unusable with verbatimModuleSyntax); 2 is Argon2id.
const ARGON2ID = 2;

/** OWASP Password Storage Cheat Sheet minimum for Argon2id: m=19 MiB, t=2, p=1. */
const ARGON2_OPTIONS = {
  algorithm: ARGON2ID,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
};

/** Verifies `pbkdf2_sha256$<iterations>$<saltHex>$<digestHex>` hashes produced by app.py. */
const verifyLegacy = async (password: string, stored: string): Promise<boolean> => {
  const legacy = parseLegacyHash(stored);
  if (!legacy) return false;
  const candidate = await pbkdf2Async(
    password,
    legacy.salt,
    legacy.iterations,
    legacy.digest.length,
    'sha256',
  );
  return timingSafeEqual(candidate, legacy.digest);
};

export const passwordHasher: PasswordHasher = {
  hash: (password) => hash(password, ARGON2_OPTIONS),

  async verify(password, stored) {
    if (stored.startsWith('pbkdf2_sha256$')) return verifyLegacy(password, stored);
    if (!stored.startsWith('$argon2id$')) return false;
    try {
      return await verify(stored, password);
    } catch {
      return false;
    }
  },

  needsRehash: (stored) => !stored.startsWith('$argon2id$'),
};
