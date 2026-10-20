import { Hono } from 'hono';
import { afterEach, expect, it, vi } from 'vitest';
afterEach(() => vi.restoreAllMocks());
import { createHostedApp } from '../src/lazy-app.ts';
import { loadConfig } from '../../api/src/platform/config.ts';

it.each([
  [{}, 'ERR_CONFIG_DATA_KEY_MISSING'],
  [{ MASCLI_DATA_KEY: 'invalid-private-key' }, 'ERR_CONFIG_DATA_KEY_INVALID'],
  [{ MASCLI_DATA_KEY: Buffer.alloc(32).toString('base64') }, 'ERR_CONFIG_DATABASE_URL_MISSING'],
])(
  'identifies configuration failures without returning environment values (%s)',
  async (env, code) => {
    const logs = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const hosted = createHostedApp(async () => {
      loadConfig({ ...env, NODE_ENV: 'production' });
      return new Hono();
    });
    const response = await hosted.request('/health');
    expect(response.status).toBe(503);
    expect(logs).toHaveBeenCalledWith('MASCLI demo initialization failed', { code });
    expect(await response.json()).toEqual({ detail: 'La demo no está disponible temporalmente' });
    expect(JSON.stringify(logs.mock.calls)).not.toContain('invalid-private-key');
  },
);

it('shares initialization between concurrent requests and keeps the backend session instance', async () => {
  let starts = 0;
  let unblock = () => {};
  const wait = new Promise<void>((resolve) => (unblock = resolve));
  const hosted = createHostedApp(async () => {
    starts++;
    await wait;
    return new Hono().get('/health', (c) => c.json({ ok: true }));
  });
  const requests = [hosted.request('/health'), hosted.request('/health')];
  unblock();
  expect((await Promise.all(requests)).map((r) => r.status)).toEqual([200, 200]);
  await hosted.request('/health');
  expect(starts).toBe(1);
});

it('returns a generic error without secrets and retries after a failed initialization', async () => {
  let starts = 0;
  const logs = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const hosted = createHostedApp(async () => {
    if (++starts === 1) throw new Error('postgres://sensitive-secret@example.test/demo');
    return new Hono().get('/health', (c) => c.json({ ok: true }));
  });
  const failure = await hosted.request('/health');
  expect(failure.status).toBe(503);
  expect(failure.headers.get('cache-control')).toBe('no-store');
  expect(await failure.text()).not.toContain('sensitive-secret');
  expect(JSON.stringify(logs.mock.calls)).not.toContain('sensitive-secret');
  expect((await hosted.request('/health')).status).toBe(200);
  expect(starts).toBe(2);
});
