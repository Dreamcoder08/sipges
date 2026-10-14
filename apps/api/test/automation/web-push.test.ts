import { createECDH, createPublicKey, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { isPushEndpoint } from '../../src/contexts/automation/application/index.ts';
import {
  encryptPush,
  generateVapidKeys,
  vapidAuthorization,
} from '../../src/contexts/automation/infrastructure/index.ts';

describe('web push', () => {
  it('encrypts exactly like the RFC 8291 example', () => {
    const body = encryptPush(
      Buffer.from('When I grow up, I want to be a watermelon'),
      {
        p256dh:
          'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
        auth: 'BTBZMqHH6r4Tts7J_aSIgg',
      },
      { privateKey: Buffer.from('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw', 'base64url') },
      Buffer.from('DGv6ra1nlYgDCS1FRnbzlw', 'base64url'),
    );
    expect(body.toString('base64url')).toBe(
      'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
    );
  });

  it('signs a VAPID token for the push service origin that verifies with the public key', () => {
    const keys = { ...generateVapidKeys(), subject: 'mailto:ops@example.org' };
    const header = vapidAuthorization(
      keys,
      'https://fcm.googleapis.com/fcm/send/abc',
      new Date('2026-10-14T10:00:00Z'),
    );
    const [, jwt = '', k] = /^vapid t=([^,]+), k=(.+)$/.exec(header) ?? [];
    expect(k).toBe(keys.publicKey);
    const [h = '', c = '', s = ''] = jwt.split('.');
    expect(JSON.parse(Buffer.from(c, 'base64url').toString())).toEqual({
      aud: 'https://fcm.googleapis.com',
      exp: Date.parse('2026-10-14T22:00:00Z') / 1000,
      sub: 'mailto:ops@example.org',
    });
    const pub = Buffer.from(keys.publicKey, 'base64url');
    const key = createPublicKey({
      key: {
        kty: 'EC',
        crv: 'P-256',
        x: pub.subarray(1, 33).toString('base64url'),
        y: pub.subarray(33).toString('base64url'),
      },
      format: 'jwk',
    });
    expect(
      verify(
        'sha256',
        Buffer.from(`${h}.${c}`),
        { key, dsaEncoding: 'ieee-p1363' },
        Buffer.from(s, 'base64url'),
      ),
    ).toBe(true);
    expect(Buffer.from(keys.privateKey, 'base64url')).toHaveLength(32);
    const ecdh = createECDH('prime256v1');
    ecdh.setPrivateKey(Buffer.from(keys.privateKey, 'base64url'));
    expect(ecdh.getPublicKey().toString('base64url')).toBe(keys.publicKey);
  });

  it('accepts only the major browsers push services', () => {
    expect(isPushEndpoint('https://fcm.googleapis.com/fcm/send/x')).toBe(true);
    expect(isPushEndpoint('https://updates.push.services.mozilla.com/wpush/v2/x')).toBe(true);
    expect(isPushEndpoint('https://web.push.apple.com/x')).toBe(true);
    expect(isPushEndpoint('https://wns2-db5p.notify.windows.com/w/?token=x')).toBe(true);
    expect(isPushEndpoint('https://evil.example/fcm.googleapis.com')).toBe(false);
    expect(isPushEndpoint('http://fcm.googleapis.com/x')).toBe(false);
    expect(isPushEndpoint('https://169.254.169.254/latest')).toBe(false);
  });
});
