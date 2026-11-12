import { createHash, randomBytes } from 'node:crypto';
import type { SessionTokens } from '../application/ports.ts';

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/** Domain separation: a session id is never the hash of anything else SIPGES stores. */
const PUBLIC_ID_PREFIX = 'sipges-session-id:';

/** Opaque bearer tokens; only their SHA-256 is stored (parity with app.py). */
export const sessionTokens: SessionTokens = {
  newToken: () => randomBytes(32).toString('hex'),
  hash: sha256,
  publicId: (tokenHash) => sha256(`${PUBLIC_ID_PREFIX}${tokenHash}`).slice(0, 32),
};
