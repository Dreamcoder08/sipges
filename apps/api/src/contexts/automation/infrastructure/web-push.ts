import {
  type KeyObject,
  createCipheriv,
  createECDH,
  createHmac,
  createPrivateKey,
  randomBytes,
  sign,
} from 'node:crypto';
import type { PushSender } from '../application/ports.ts';

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');
const unb64 = (text: string) => Buffer.from(text, 'base64url');
const hmac = (key: Uint8Array, data: Uint8Array) => createHmac('sha256', key).update(data).digest();

/** Record size advertised in the aes128gcm header; one record carries the whole message. */
const RECORD_SIZE = 4096;

/**
 * Message encryption for Web Push (RFC 8291, `aes128gcm` content coding of RFC 8188).
 * `ephemeral` and `salt` exist only so tests can reproduce the RFC example.
 */
export const encryptPush = (
  plaintext: Uint8Array,
  subscription: { p256dh: string; auth: string },
  ephemeral: { privateKey: Uint8Array } | null = null,
  salt: Uint8Array = randomBytes(16),
): Buffer => {
  const ecdh = createECDH('prime256v1');
  if (ephemeral) ecdh.setPrivateKey(Buffer.from(ephemeral.privateKey));
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const uaPublic = unb64(subscription.p256dh);
  const secret = ecdh.computeSecret(uaPublic);

  const prkKey = hmac(unb64(subscription.auth), secret);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic, Buffer.of(1)]);
  const ikm = hmac(prkKey, keyInfo);
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01', 'binary')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01', 'binary')).subarray(0, 12);

  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  // 0x02 marks the last (and only) record; no padding.
  const body = Buffer.concat([
    cipher.update(Buffer.concat([plaintext, Buffer.of(2)])),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  const header = Buffer.alloc(21);
  Buffer.from(salt).copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, body]);
};

export type VapidKeys = {
  readonly publicKey: string;
  readonly privateKey: string;
  readonly subject: string;
};

/** Builds the ES256 signing key from the raw base64url VAPID key pair (RFC 8292). */
const vapidSigner = (keys: VapidKeys): KeyObject => {
  const pub = unb64(keys.publicKey);
  if (pub.length !== 65 || pub[0] !== 4)
    throw new Error('MASCLI_VAPID_PUBLIC_KEY must be an uncompressed P-256 key');
  return createPrivateKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      d: keys.privateKey,
      x: b64(pub.subarray(1, 33)),
      y: b64(pub.subarray(33)),
    },
    format: 'jwk',
  });
};

/** `vapid t=<jwt>, k=<public key>` for one push service origin, valid for 12 hours. */
export const vapidAuthorization = (
  keys: VapidKeys,
  endpoint: string,
  now: Date,
  key = vapidSigner(keys),
) => {
  const header = b64(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64(
    Buffer.from(
      JSON.stringify({
        aud: new URL(endpoint).origin,
        exp: Math.floor(now.getTime() / 1000) + 12 * 3600,
        sub: keys.subject,
      }),
    ),
  );
  const signature = sign('sha256', Buffer.from(`${header}.${claims}`), {
    key,
    dsaEncoding: 'ieee-p1363',
  });
  return `vapid t=${header}.${claims}.${b64(signature)}, k=${keys.publicKey}`;
};

/** Generates a VAPID key pair as base64url raw keys (public uncompressed, private scalar). */
export const generateVapidKeys = () => {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  // The scalar may have leading zero bytes, which getPrivateKey drops.
  const scalar = Buffer.concat([Buffer.alloc(32), ecdh.getPrivateKey()]).subarray(-32);
  return { publicKey: b64(ecdh.getPublicKey()), privateKey: b64(scalar) };
};

/** Sends encrypted pushes; 404 and 410 report a subscription the browser dropped. */
export const createWebPushSender = (
  keys: VapidKeys,
  fetchImpl: typeof fetch = fetch,
): PushSender => {
  const key = vapidSigner(keys);
  return {
    publicKey: keys.publicKey,
    async send(subscription, payload, now) {
      const body = encryptPush(Buffer.from(JSON.stringify(payload)), subscription);
      let response: Response;
      try {
        response = await fetchImpl(subscription.endpoint, {
          method: 'POST',
          headers: {
            authorization: vapidAuthorization(keys, subscription.endpoint, now, key),
            'content-encoding': 'aes128gcm',
            'content-type': 'application/octet-stream',
            ttl: '86400',
            urgency: 'normal',
          },
          body,
          redirect: 'error',
          signal: AbortSignal.timeout(10_000),
        });
      } catch (error) {
        throw new Error('Servicio de push sin conexión', { cause: error });
      }
      await response.body?.cancel().catch(() => undefined);
      if (response.status === 404 || response.status === 410) return 'gone';
      if (!response.ok) throw new Error(`Servicio de push: respuesta HTTP ${response.status}`);
      return 'sent';
    },
  };
};
