import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { SecretCipher } from '../application/ports.ts';

const VERSION = 'v1';
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

/**
 * AES-256-GCM sealing for secrets at rest (ADR 0004).
 * Format: `v1.<base64url(nonce | ciphertext | tag)>`. Values are always sealed with `key`;
 * `previousKeys` only open values sealed before a rotation, so the API can serve while
 * `pnpm --filter @sipges/api rotate:data-key` re-encrypts them (docs/operations/data-key-rotation.md).
 * The GCM tag rejects a wrong key, so trying each key in turn is unambiguous.
 */
export const createSecretCipher = (
  key: Buffer,
  previousKeys: readonly Buffer[] = [],
): SecretCipher => {
  const keys = [key, ...previousKeys];
  if (keys.some((candidate) => candidate.length !== 32)) {
    throw new Error('SIPGES_DATA_KEY must decode to 32 bytes');
  }

  const openWith = (candidate: Buffer, raw: Buffer): string => {
    const decipher = createDecipheriv('aes-256-gcm', candidate, raw.subarray(0, NONCE_BYTES));
    decipher.setAuthTag(raw.subarray(raw.length - TAG_BYTES));
    return Buffer.concat([
      decipher.update(raw.subarray(NONCE_BYTES, raw.length - TAG_BYTES)),
      decipher.final(),
    ]).toString('utf8');
  };

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
      let failure: unknown;
      for (const candidate of keys) {
        try {
          return openWith(candidate, raw);
        } catch (error) {
          failure ??= error;
        }
      }
      throw failure;
    },
  };
};
