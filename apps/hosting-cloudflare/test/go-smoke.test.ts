import { describe, expect, it, vi } from 'vitest';
import { GO_ROUTES } from '../src/go-routes.ts';
import { smokeGoRoute } from '../src/go-smoke.ts';

const unauthorized = () =>
  new Response('{"detail":"Inicie sesión"}', {
    status: 401,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });

const run = (fetcher: typeof fetch, routes: Parameters<typeof smokeGoRoute>[0]['routes']) => {
  const sleep = vi.fn(async () => {});
  const result = smokeGoRoute({
    routes,
    baseUrl: 'https://sipges.example.test',
    fetcher,
    sleep,
    attempts: 3,
  });
  return { result, sleep };
};

describe('Go route smoke test', () => {
  it('makes no request while GO_ROUTES is empty', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const { result } = run(fetcher, GO_ROUTES);
    expect(GO_ROUTES).toEqual([]);
    await expect(result).resolves.toEqual({ outcome: 'skipped' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('probes a listed GET route with no session and accepts the JSON 401', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => unauthorized());
    const { result } = run(fetcher, [
      { method: 'POST', path: '/api/eventos' },
      { method: 'GET', path: '/api/eventos/:id' },
      { method: 'GET', path: '/api/dashboard' },
    ]);
    await expect(result).resolves.toEqual({ outcome: 'passed', path: '/api/dashboard' });
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0] ?? [];
    expect(url).toBe('https://sipges.example.test/api/dashboard');
    expect(new Headers(init?.headers).has('cookie')).toBe(false);
    expect(init?.redirect).toBe('manual');
  });

  it('fills a :name segment when every listed route has one', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => unauthorized());
    const { result } = run(fetcher, [{ method: 'GET', path: '/api/eventos/:id/history' }]);
    await expect(result).resolves.toEqual({
      outcome: 'passed',
      path: '/api/eventos/smoke/history',
    });
  });

  it('fails on a dead container: the JSON 503 of the Worker on every attempt', async () => {
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response('{"detail":"SIPGES no está disponible temporalmente"}', {
          status: 503,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const { result, sleep } = run(fetcher, [{ method: 'GET', path: '/api/dashboard' }]);
    await expect(result).resolves.toEqual({
      outcome: 'failed',
      path: '/api/dashboard',
      last: 'HTTP 503',
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('retries, so a container still starting does not fail the deploy', async () => {
    const fetcher = vi
      .fn<typeof fetch>(async () => unauthorized())
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(new Response('down', { status: 500 }));
    const { result } = run(fetcher, [{ method: 'GET', path: '/api/dashboard' }]);
    await expect(result).resolves.toEqual({ outcome: 'passed', path: '/api/dashboard' });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('refuses a 200 or a 401 that is not JSON with a detail', async () => {
    for (const response of [
      () => new Response('{"detail":"x"}', { headers: { 'content-type': 'application/json' } }),
      () => new Response('nope', { status: 401, headers: { 'content-type': 'text/plain' } }),
      () => new Response('{}', { status: 401, headers: { 'content-type': 'application/json' } }),
    ]) {
      const { result } = run(
        vi.fn<typeof fetch>(async () => response()),
        [{ method: 'GET', path: '/api/dashboard' }],
      );
      await expect(result).resolves.toMatchObject({ outcome: 'failed' });
    }
  });

  it('never reports a body or an error message', async () => {
    const { result } = run(
      vi.fn<typeof fetch>(async () => {
        throw new Error('postgres://secret@db');
      }),
      [{ method: 'GET', path: '/api/dashboard' }],
    );
    const outcome = await result;
    expect(outcome).toEqual({ outcome: 'failed', path: '/api/dashboard', last: 'Error' });
  });
});
