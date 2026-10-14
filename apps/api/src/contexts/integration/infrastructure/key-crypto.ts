import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { KeyCrypto } from '../application/ports.ts';

const sha256 = (value: string) => createHash('sha256').update(value).digest();

/** Random 256-bit secrets stored as SHA-256 (high-entropy tokens need no slow hash). */
export const keyCrypto: KeyCrypto = {
  prefix: () => randomBytes(6).toString('hex'),
  secret: () => randomBytes(32).toString('base64url'),
  hash: (secret) => sha256(secret).toString('hex'),
  matches: (secret, hash) => {
    const expected = Buffer.from(hash, 'hex');
    const actual = sha256(secret);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  },
};
