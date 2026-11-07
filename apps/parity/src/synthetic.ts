import { generateKeyPairSync } from 'node:crypto';

/** Fixed synthetic values both APIs start with; never a real credential. */
export const CRON_SECRET = 'synthetic-parity-cron-secret-000000';

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
