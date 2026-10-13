import { createHash, randomBytes } from 'node:crypto';
import type { SessionTokens } from '../application/ports.ts';

/** Opaque bearer tokens; only their SHA-256 is stored (parity with app.py). */
export const sessionTokens: SessionTokens = {
  newToken: () => randomBytes(32).toString('hex'),
  hash: (token) => createHash('sha256').update(token).digest('hex'),
};
