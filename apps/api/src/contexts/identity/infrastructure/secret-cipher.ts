import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { SecretCipher } from '../application/ports.ts';

const VERSION = 'v1';
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

/**
 * AES-256-GCM sealing for secrets at rest (ADR 0004).
 * Format: `v1.<base64url(nonce | ciphertext | tag)>`; the version prefix allows key rotation.
 */
export const createSecretCipher = (key: Buffer): SecretCipher => {
  if (key.length !== 32) throw new Error('SIPGES_DATA_KEY must decode to 32 bytes');

  return {
    seal(plaintext) {
      const nonce = randomBytes(NONCE_BYTES);
      const cipher = createCipheriv('aes-256-gcm', key, nonce);
      const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      return `${VERSION}.${Buffer.concat([nonce, body, cipher.getAuthTag()]).toString('base64url')}`;
    },

    open(sealed) {
      const [version, payload] = sealed.split('.');
      if (version !== VERSION || !payload) throw new Error('Unsupported sealed secret');
      const raw = Buffer.from(payload, 'base64url');
      if (raw.length < NONCE_BYTES + TAG_BYTES) throw new Error('Malformed sealed secret');
      const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, NONCE_BYTES));
      decipher.setAuthTag(raw.subarray(raw.length - TAG_BYTES));
      return Buffer.concat([
        decipher.update(raw.subarray(NONCE_BYTES, raw.length - TAG_BYTES)),
        decipher.final(),
      ]).toString('utf8');
    },
  };
};
