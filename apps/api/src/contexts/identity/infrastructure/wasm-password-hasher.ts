import { argon2Verify, argon2id, createSHA256, pbkdf2 } from 'hash-wasm';
import type { PasswordHasher } from '../application/ports.ts';
import { parseLegacyHash, sameDigest } from './legacy-hash.ts';

/**
 * Argon2id and PBKDF2 in WebAssembly, for runtimes without native addons (Cloudflare Workers).
 * Same parameters and PHC encoding as the native hasher, so either one verifies the other's
 * hashes. PBKDF2 runs in WebAssembly because Workers' WebCrypto refuses more than 100,000
 * iterations and app.py used 310,000.
 */
export const wasmPasswordHasher: PasswordHasher = {
  hash: (password) =>
    argon2id({
      password,
      salt: crypto.getRandomValues(new Uint8Array(16)),
      // OWASP Password Storage Cheat Sheet minimum for Argon2id: m=19 MiB, t=2, p=1.
      memorySize: 19456,
      iterations: 2,
      parallelism: 1,
      hashLength: 32,
      outputType: 'encoded',
    }),

  async verify(password, stored) {
    if (stored.startsWith('pbkdf2_sha256$')) {
      const legacy = parseLegacyHash(stored);
      if (!legacy) return false;
      const candidate = await pbkdf2({
        password,
        salt: legacy.salt,
        iterations: legacy.iterations,
        hashLength: legacy.digest.length,
        hashFunction: createSHA256(),
        outputType: 'binary',
      });
      return sameDigest(candidate, legacy.digest);
    }
    if (!stored.startsWith('$argon2id$')) return false;
    try {
      return await argon2Verify({ password, hash: stored });
    } catch {
      return false;
    }
  },

  needsRehash: (stored) => !stored.startsWith('$argon2id$'),
};
