import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/platform/config.ts';

describe('cookie Secure policy (parity with app.py:10-18, docs/secure-cookies.md)', () => {
  it('defaults to Secure when MASCLI_COOKIE_SECURE is unset', () => {
    expect(loadConfig({}).cookieSecure).toBe(true);
  });

  it('is Secure for exactly "1"', () => {
    expect(loadConfig({ MASCLI_COOKIE_SECURE: '1' }).cookieSecure).toBe(true);
  });

  it('disables Secure only for exactly "0"', () => {
    expect(loadConfig({ MASCLI_COOKIE_SECURE: '0' }).cookieSecure).toBe(false);
  });

  it.each(['', 'true', 'false', 'yes', ' 1', '1 ', '00', 'on'])(
    'rejects %j with the Python error message',
    (value) => {
      expect(() => loadConfig({ MASCLI_COOKIE_SECURE: value })).toThrow(
        "MASCLI_COOKIE_SECURE must be unset or exactly '0' or '1'",
      );
    },
  );
});

describe('listen address', () => {
  it('defaults to 127.0.0.1:8000 like the Python launchers', () => {
    expect(loadConfig({})).toMatchObject({ host: '127.0.0.1', port: 8000 });
  });

  it('accepts an explicit host and port', () => {
    expect(loadConfig({ MASCLI_HOST: '0.0.0.0', MASCLI_PORT: '10000' })).toMatchObject({
      host: '0.0.0.0',
      port: 10000,
    });
  });

  it.each(['0', '65536', 'abc', '80.5', '', '-1'])('rejects port %j', (value) => {
    expect(() => loadConfig({ MASCLI_PORT: value })).toThrow(
      'MASCLI_PORT must be an integer between 1 and 65535',
    );
  });
});
