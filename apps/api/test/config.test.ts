import { describe, expect, it } from 'vitest';
import { loadConfig as load } from '../src/platform/config.ts';
import { TEST_ENV } from './support/test-app.ts';

const loadConfig = (env: Record<string, string>) => load({ ...TEST_ENV, ...env });

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

describe('MASCLI_DATA_KEY (ADR 0004)', () => {
  it('is required', () => {
    expect(() => load({})).toThrow('MASCLI_DATA_KEY is required (base64, 32 bytes)');
  });

  it.each(['', 'not-base64!', Buffer.alloc(16).toString('base64')])('rejects %j', (value) => {
    expect(() => loadConfig({ MASCLI_DATA_KEY: value })).toThrow(
      'MASCLI_DATA_KEY must decode to 32 bytes',
    );
  });

  it('decodes a 32-byte base64 key', () => {
    expect(loadConfig({}).dataKey).toHaveLength(32);
  });
});

describe('bootstrap admin settings', () => {
  it('defaults like Python with the neutral display name of ADR 0008 #13', () => {
    expect(load({ MASCLI_DATA_KEY: TEST_ENV.MASCLI_DATA_KEY })).toMatchObject({
      admin: { username: 'admin', password: '', fullName: 'Administrator' },
    });
  });

  it('normalizes the admin username', () => {
    expect(loadConfig({ MASCLI_ADMIN_USERNAME: '  Jefa ' }).admin.username).toBe('jefa');
  });
});

describe('production database guard (verifier finding S1)', () => {
  it('refuses embedded PGlite when NODE_ENV=production', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(
      'MASCLI_DATABASE_URL is required when NODE_ENV=production',
    );
  });

  it('accepts production with a database URL', () => {
    expect(
      loadConfig({
        NODE_ENV: 'production',
        MASCLI_DATABASE_URL: 'postgres://u:p@db.example:5432/m',
      }).databaseUrl,
    ).toBe('postgres://u:p@db.example:5432/m');
  });
});

describe('MASCLI_TRUST_PROXY', () => {
  it('defaults to not trusting forwarded headers', () => {
    expect(loadConfig({}).trustProxy).toBe(false);
  });

  it('accepts exactly 0 or 1', () => {
    expect(loadConfig({ MASCLI_TRUST_PROXY: '1' }).trustProxy).toBe(true);
    expect(loadConfig({ MASCLI_TRUST_PROXY: '0' }).trustProxy).toBe(false);
    expect(() => loadConfig({ MASCLI_TRUST_PROXY: 'yes' })).toThrow(
      "MASCLI_TRUST_PROXY must be unset or exactly '0' or '1'",
    );
  });
});

describe('Ollama embeddings settings (RC 2.5)', () => {
  it('defaults to a local server and nomic-embed-text like app.py', () => {
    expect(loadConfig({}).ollama).toEqual({
      baseUrl: 'http://127.0.0.1:11434',
      model: 'nomic-embed-text',
    });
  });

  it('accepts an http(s) URL and a model name', () => {
    expect(
      loadConfig({
        MASCLI_OLLAMA_URL: 'https://ollama.internal',
        MASCLI_OLLAMA_EMBED_MODEL: 'bge-m3',
      }).ollama,
    ).toEqual({ baseUrl: 'https://ollama.internal', model: 'bge-m3' });
  });

  it.each([
    ['not a url', 'MASCLI_OLLAMA_URL must be an absolute URL'],
    ['file:///tmp/x', 'MASCLI_OLLAMA_URL must use http or https'],
  ])('rejects %j', (value, message) => {
    expect(() => loadConfig({ MASCLI_OLLAMA_URL: value })).toThrow(message);
  });
});

describe('MASCLI_WEB_DIR', () => {
  it('is optional and passed through', () => {
    expect(loadConfig({}).webDir).toBeUndefined();
    expect(loadConfig({ MASCLI_WEB_DIR: '' }).webDir).toBeUndefined();
    expect(loadConfig({ MASCLI_WEB_DIR: 'apps/web/dist' }).webDir).toBe('apps/web/dist');
  });
});
