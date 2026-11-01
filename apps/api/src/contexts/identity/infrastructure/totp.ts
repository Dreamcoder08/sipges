import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { TotpService } from '../application/ports.ts';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_SECONDS = 30;
const DRIFT_STEPS = [-1, 0, 1] as const;

const base32Encode = (bytes: Buffer): string => {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
};

const base32Decode = (text: string): Buffer => {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of text.replace(/=+$/, '').toUpperCase()) {
    const index = ALPHABET.indexOf(char);
    if (index < 0) throw new Error('Invalid base32 secret');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
};

/** RFC 4226 HOTP truncated to 6 digits, as app.py totp_code. */
const hotp = (key: Buffer, counter: number): string => {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', key).update(message).digest();
  const offset = (digest.at(-1) ?? 0) & 15;
  const binary = digest.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 1_000_000).padStart(6, '0');
};

const stepAt = (at: Date) => Math.floor(at.getTime() / 1000 / STEP_SECONDS);

/** RFC 6238 TOTP, SHA-1, 6 digits, 30 s, ±1 step (parity) plus a replay guard (ADR 0004). */
export const totp: TotpService & { codeAt(secret: string, at: Date): string } = {
  generateSecret: () => base32Encode(randomBytes(20)),

  uri: (username, secret) =>
    `otpauth://totp/SIPGES:${encodeURIComponent(username)}?secret=${secret}&issuer=SIPGES&algorithm=SHA1&digits=6&period=30`,

  codeAt: (secret, at) => hotp(base32Decode(secret), stepAt(at)),

  verify(secret, code, at, lastStep) {
    if (!/^\d{6}$/.test(code) || !secret) return { ok: false };
    const key = base32Decode(secret);
    const current = stepAt(at);
    for (const drift of DRIFT_STEPS) {
      const step = current + drift;
      if (lastStep !== null && step <= lastStep) continue;
      if (timingSafeEqual(Buffer.from(hotp(key, step)), Buffer.from(code)))
        return { ok: true, step };
    }
    return { ok: false };
  },
};
