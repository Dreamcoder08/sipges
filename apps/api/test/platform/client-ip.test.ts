import { describe, expect, it } from 'vitest';
import { resolveClientIp } from '../../src/platform/http/client-ip.ts';

describe('resolveClientIp (verifier finding S2)', () => {
  it('uses the socket peer when the proxy is not trusted, ignoring spoofable headers', () => {
    expect(
      resolveClientIp({ trustProxy: false, forwardedFor: '1.2.3.4', socket: '10.0.0.5' }),
    ).toBe('10.0.0.5');
  });

  it('uses the right-most X-Forwarded-For entry (added by the trusted proxy)', () => {
    expect(
      resolveClientIp({
        trustProxy: true,
        forwardedFor: '6.6.6.6, 198.51.100.7 , 203.0.113.9',
        socket: '10.0.0.5',
      }),
    ).toBe('203.0.113.9');
  });

  it('falls back to the socket peer when a trusted proxy sent no header', () => {
    expect(resolveClientIp({ trustProxy: true, forwardedFor: undefined, socket: '10.0.0.5' })).toBe(
      '10.0.0.5',
    );
    expect(resolveClientIp({ trustProxy: true, forwardedFor: ' , ', socket: '10.0.0.5' })).toBe(
      '10.0.0.5',
    );
  });

  it('never returns an empty subject', () => {
    expect(resolveClientIp({ trustProxy: false, forwardedFor: undefined, socket: undefined })).toBe(
      'unknown',
    );
  });
});
