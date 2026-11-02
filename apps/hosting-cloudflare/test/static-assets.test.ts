import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ASSET_CACHE, CESIUM_CACHE, SPA_CSP } from '../../api/src/platform/http/spa.ts';
import type { Env } from '../src/bindings.ts';

const mocks = vi.hoisted(() => ({
  postgres: vi.fn(),
  pendingMigrations: vi.fn(async () => [] as string[]),
  buildContainer: vi.fn(),
  backendFetch: vi.fn(),
}));

vi.mock('../../api/src/platform/database/postgres.ts', () => ({ postgresClient: mocks.postgres }));
vi.mock('../src/migrations.ts', () => ({ MIGRATIONS: [] }));
vi.mock('../../api/src/platform/database/migrator.ts', () => ({
  pendingMigrations: mocks.pendingMigrations,
}));
vi.mock('../../api/src/compose.ts', () => ({ buildContainer: mocks.buildContainer }));
vi.mock('../../api/src/app.ts', () => ({ createApp: () => ({ fetch: mocks.backendFetch }) }));
vi.mock('../../api/src/contexts/documents/infrastructure/index.ts', () => ({
  inlineDocumentReader: {},
}));
vi.mock('../../api/src/contexts/identity/infrastructure/portable-password-hasher.ts', () => ({
  portablePasswordHasher: {},
}));

const SHELL = '<!doctype html><title>SIPGES</title><div id="root"></div>';

/** A Static Assets binding over synthetic files; bodies are streams, as in workerd. */
const assetsBinding = (files: Record<string, string>) => ({
  fetch: vi.fn(async (request: Request) => {
    const path = new URL(request.url).pathname.slice(1);
    const content = files[path];
    return content === undefined
      ? new Response('missing', { status: 404 })
      : new Response(new Blob([content]).stream());
  }),
});

const FILES = {
  'index.html': SHELL,
  'assets/index-abc.js': 'ok()',
  'cesium/Workers/createVerticesFromHeightmap.js': 'worker()',
  'sw.js': 'self.addEventListener("fetch", () => {})',
};

const envWith = (assets: ReturnType<typeof assetsBinding>, vars: Record<string, string>) =>
  ({
    HYPERDRIVE: { connectionString: 'postgresql://synthetic:synthetic@binding.invalid:5432/x' },
    SIPGES_DATA_KEY: Buffer.alloc(32).toString('base64'),
    EVIDENCE: {},
    ASSETS: assets,
    ...vars,
  }) as unknown as Env;

const HOST = 'sipges.example.test';
const ctx = { waitUntil: () => {} };
const get = (path: string, headers: Record<string, string> = {}) =>
  new Request(`https://${HOST}${path}`, { headers: { host: HOST, ...headers } });

const freshWorker = async () => {
  vi.resetModules();
  return (await import('../src/index.ts')).default;
};

const expectNoBackend = () => {
  expect(mocks.postgres).not.toHaveBeenCalled();
  expect(mocks.pendingMigrations).not.toHaveBeenCalled();
  expect(mocks.buildContainer).not.toHaveBeenCalled();
  expect(mocks.backendFetch).not.toHaveBeenCalled();
};

describe('Worker static assets without the backend', () => {
  let assets: ReturnType<typeof assetsBinding>;
  let env: Env;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.postgres.mockReturnValue({ client: {}, close: async () => {} });
    mocks.buildContainer.mockResolvedValue({ runtime: { scheduled: async () => {} } });
    mocks.backendFetch.mockImplementation(async () => new Response('backend'));
    assets = assetsBinding(FILES);
    env = envWith(assets, { SIPGES_ALLOWED_HOSTS: HOST });
  });

  it('serves /assets/* with immutable caching and security headers, never opening a connection', async () => {
    const worker = await freshWorker();
    const res = await worker.fetch(get('/assets/index-abc.js'), env, ctx);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok()');
    expect(res.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe(ASSET_CACHE);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('strict-transport-security')).toContain('max-age=');
    expectNoBackend();
  });

  it('serves /cesium/* and root files under the SPA policy without the backend', async () => {
    const worker = await freshWorker();
    const cesium = await worker.fetch(
      get('/cesium/Workers/createVerticesFromHeightmap.js'),
      env,
      ctx,
    );
    expect(cesium.status).toBe(200);
    expect(await cesium.text()).toBe('worker()');
    expect(cesium.headers.get('cache-control')).toBe(CESIUM_CACHE);
    expect(cesium.headers.get('content-security-policy')).toBe(SPA_CSP);

    const sw = await worker.fetch(get('/sw.js'), env, ctx);
    expect(sw.status).toBe(200);
    expect(sw.headers.get('content-security-policy')).toBe(SPA_CSP);
    expect(sw.headers.get('cache-control')).toBe('no-store');
    expectNoBackend();
  });

  it('serves the HTML shell for a browser navigation with the SPA CSP, without the backend', async () => {
    const worker = await freshWorker();
    const res = await worker.fetch(get('/registros', { accept: 'text/html' }), env, ctx);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe(SHELL);
    expect(res.headers.get('content-security-policy')).toBe(SPA_CSP);
    expect(res.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expectNoBackend();
  });

  it('answers an unknown asset with 404 and no backend', async () => {
    const worker = await freshWorker();
    const res = await worker.fetch(get('/assets/missing-xyz.js'), env, ctx);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ detail: 'Not Found' });
    expectNoBackend();
  });

  it('serves an empty build file as an empty 200, not a 404', async () => {
    const worker = await freshWorker();
    const empty = { fetch: vi.fn(async () => new Response(null, { status: 200 })) };
    const res = await worker.fetch(
      get('/assets/empty-abc.css'),
      envWith(empty, { SIPGES_ALLOWED_HOSTS: HOST }),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');
    expectNoBackend();
  });

  it('answers a failing asset binding with a JSON 500 that keeps the security headers', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const worker = await freshWorker();
    const broken = {
      fetch: vi.fn(async () => {
        throw new Error('synthetic binding failure');
      }),
    };
    const res = await worker.fetch(
      get('/assets/index-abc.js'),
      envWith(broken, { SIPGES_ALLOWED_HOSTS: HOST }),
      ctx,
    );
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ detail: 'Internal Server Error' });
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expectNoBackend();
  });

  it('still refuses a foreign Host for static files', async () => {
    const worker = await freshWorker();
    const res = await worker.fetch(
      new Request('https://evil.invalid/assets/index-abc.js', {
        headers: { host: 'evil.invalid' },
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(400);
    expect(assets.fetch).not.toHaveBeenCalled();
    expectNoBackend();
  });

  it('fails closed with 503 when SIPGES_ALLOWED_HOSTS is missing', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const worker = await freshWorker();
    const res = await worker.fetch(get('/assets/index-abc.js'), envWith(assets, {}), ctx);
    expect(res.status).toBe(503);
    expect(assets.fetch).not.toHaveBeenCalled();
    expectNoBackend();
  });

  it('keeps API calls, /health and /health/ready on the backend', async () => {
    const worker = await freshWorker();
    for (const path of ['/system/auth/me', '/health', '/health/ready']) {
      const res = await worker.fetch(get(path, { accept: 'text/html' }), env, ctx);
      expect(await res.text(), path).toBe('backend');
    }
    const post = await worker.fetch(
      new Request(`https://${HOST}/assets/index-abc.js`, {
        method: 'POST',
        headers: { host: HOST },
      }),
      env,
      ctx,
    );
    expect(await post.text()).toBe('backend');
    // Percent-encoded API paths are matched as Hono decodes them, so they still reach the API.
    const encoded = await worker.fetch(get('/%61pi/session', { accept: 'text/html' }), env, ctx);
    expect(await encoded.text()).toBe('backend');
    expect(mocks.backendFetch).toHaveBeenCalledTimes(5);
  });
});
