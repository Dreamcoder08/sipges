import { generateKeyPairSync } from 'node:crypto';

/** Fixed synthetic values both APIs start with; never a real credential. */
export const CRON_SECRET = 'synthetic-parity-cron-secret-000000';

/** The Defensoría WordPress API path both APIs ask the local double (embedder-double.ts). */
export const DEFENSORIA_PATH = '/wp-json/wp/v2/posts';

const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const { x = '', y = '' } = publicKey.export({ format: 'jwk' });
const point = Buffer.concat([
  Buffer.from([4]),
  Buffer.from(x, 'base64url'),
  Buffer.from(y, 'base64url'),
]);

/** A key pair of this run: push subscribing needs one, and nothing here ever sends. */
export const VAPID = {
  SIPGES_VAPID_PUBLIC_KEY: point.toString('base64url'),
  SIPGES_VAPID_PRIVATE_KEY: privateKey.export({ format: 'jwk' }).d ?? '',
  SIPGES_VAPID_SUBJECT: 'mailto:parity@example.org',
};
