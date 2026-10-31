import { argon2idAsync } from '@noble/hashes/argon2.js';
import { pbkdf2Async } from '@noble/hashes/pbkdf2.js';
import { sha256 } from '@noble/hashes/sha2.js';
import type { PasswordHasher } from '../application/ports.ts';
import { parseLegacyHash, sameDigest } from './legacy-hash.ts';

/** OWASP Password Storage Cheat Sheet minimum for Argon2id: m=19 MiB, t=2, p=1. */
const COST = { m: 19456, t: 2, p: 1 } as const;
/** Argon2 version 1.3, written as `v=19` in the PHC string. */
const VERSION = 19;
/**
 * The most a stored hash may ask for. A Worker isolate has 128 MB of memory, and a crafted or
 * corrupted hash must fail fast instead of allocating gigabytes or burning the CPU budget.
 */
const LIMIT = { m: 65536, t: 10, p: 4, pbkdf2: 1_000_000 } as const;

const toBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/=+$/, '');
const fromBase64 = (text: string) => {
  if (!/^[A-Za-z0-9+/]+$/.test(text)) return null;
  try {
    return Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
};

type Argon2Cost = { m: number; t: number; p: number };
type Argon2idHash = Argon2Cost & { salt: Uint8Array; digest: Uint8Array };

const PHC = new RegExp(
  `^\\$argon2id\\$v=${VERSION}\\$m=(\\d{1,7}),t=(\\d{1,4}),p=(\\d{1,3})\\$([^$]+)\\$([^$]+)$`,
);

/** A `$argon2id$v=19$m=…,t=…,p=…$salt$hash` PHC string within the Worker budget, else null. */
const parseArgon2id = (stored: string): Argon2idHash | null => {
  const match = PHC.exec(stored);
  if (!match) return null;
  const [m, t, p] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (p < 1 || p > LIMIT.p || t < 1 || t > LIMIT.t || m < 8 * p || m > LIMIT.m) return null;
  const salt = fromBase64(match[4] ?? '');
  const digest = fromBase64(match[5] ?? '');
  if (!salt || salt.length < 8 || !digest || digest.length < 16 || digest.length > 64) return null;
  return { m, t, p, salt, digest };
};

const argon2id = (password: string, salt: Uint8Array, { m, t, p }: Argon2Cost, dkLen: number) =>
  argon2idAsync(password, salt, { m, t, p, dkLen, version: VERSION, maxmem: LIMIT.m * 1024 });

/**
 * Argon2id and PBKDF2 in plain JavaScript, for runtimes without native addons or dynamic
 * WebAssembly (Cloudflare Workers refuses `WebAssembly.compile`). Same parameters and PHC
 * encoding as the native hasher, so either one verifies the other's hashes. PBKDF2 does not use
 * WebCrypto because Workers refuses more than 100,000 iterations and app.py used 310,000.
 */
export const portablePasswordHasher: PasswordHasher = {
  async hash(password) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const digest = await argon2id(password, salt, COST, 32);
    return `$argon2id$v=${VERSION}$m=${COST.m},t=${COST.t},p=${COST.p}$${toBase64(salt)}$${toBase64(digest)}`;
  },

  async verify(password, stored) {
    try {
      if (stored.startsWith('pbkdf2_sha256$')) {
        const legacy = parseLegacyHash(stored);
        if (!legacy || legacy.iterations > LIMIT.pbkdf2) return false;
        const candidate = await pbkdf2Async(sha256, password, legacy.salt, {
          c: legacy.iterations,
          dkLen: legacy.digest.length,
        });
        return sameDigest(candidate, legacy.digest);
      }
      const parsed = parseArgon2id(stored);
      if (!parsed) return false;
      const candidate = await argon2id(password, parsed.salt, parsed, parsed.digest.length);
      return sameDigest(candidate, parsed.digest);
    } catch {
      return false;
    }
  },

  needsRehash: (stored) => !stored.startsWith('$argon2id$'),
};
