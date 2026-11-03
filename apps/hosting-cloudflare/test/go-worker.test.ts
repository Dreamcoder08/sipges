import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/bindings.ts';
import type * as GoRoutes from '../src/go-routes.ts';

const mocks = vi.hoisted(() => ({
  postgres: vi.fn(),
  fetch: vi.fn(),
  containerFetch: vi.fn(),
  get: vi.fn(),
}));

vi.mock('../../api/src/platform/database/postgres.ts', () => ({ postgresClient: mocks.postgres }));
vi.mock('../src/migrations.ts', () => ({ MIGRATIONS: [] }));
vi.mock('../../api/src/platform/database/migrator.ts', () => ({
  pendingMigrations: async () => [],
}));
vi.mock('../../api/src/compose.ts', () => ({
  buildContainer: async () => ({ runtime: { scheduled: async () => {} } }),
}));
vi.mock('../../api/src/app.ts', () => ({ createApp: () => ({ fetch: mocks.fetch }) }));
vi.mock('../../api/src/contexts/documents/infrastructure/index.ts', () => ({
  inlineDocumentReader: {},
}));
vi.mock('../../api/src/contexts/identity/infrastructure/portable-password-hasher.ts', () => ({
  portablePasswordHasher: {},
}));
// One synthetic route on the list; the real list is empty (src/go-routes.ts).
vi.mock('../src/go-routes.ts', async (original) => ({
  ...(await original<typeof GoRoutes>()),
  GO_ROUTES: [{ method: 'GET', path: '/system/go-probe' }],
}));

const env = (vars: Record<string, string>) =>
  ({
    HYPERDRIVE: { connectionString: 'postgresql://synthetic@binding.hyperdrive.local/synthetic' },
    SIPGES_DATA_KEY: Buffer.alloc(32).toString('base64'),
    SIPGES_ALLOWED_HOSTS: 'localhost',
    EVIDENCE: {},
    ASSETS: {},
    GO_BACKEND: { idFromName: (name: string) => ({ name }), get: mocks.get },
    ...vars,
  }) as unknown as Env;

const ctx = { waitUntil: () => {} };
const worker = async () => {
  vi.resetModules();
  return (await import('../src/index.ts')).default;
};

describe('Worker routing to Go', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.postgres.mockReturnValue({ client: {}, close: async () => {} });
    mocks.fetch.mockImplementation(async () => new Response('ts'));
    mocks.containerFetch.mockImplementation(async () => new Response('go'));
    mocks.get.mockReturnValue({ fetch: mocks.containerFetch });
  });

  it('sends a listed route to the named ENAM instance without a Hyperdrive connection', async () => {
    const response = await (
      await worker()
    ).fetch(
      new Request('http://localhost/system/go-probe', { headers: { host: 'localhost' } }),
      env({ SIPGES_GO_ROUTING: '1' }),
      ctx,
    );
    expect(await response.text()).toBe('go');
    expect(mocks.get).toHaveBeenCalledWith({ name: 'go-enam' }, { locationHint: 'enam' });
    expect(mocks.postgres).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('keeps unlisted routes on TypeScript with the switch on', async () => {
    const response = await (
      await worker()
    ).fetch(
      new Request('http://localhost/system/other', { headers: { host: 'localhost' } }),
      env({ SIPGES_GO_ROUTING: '1' }),
      ctx,
    );
    expect(await response.text()).toBe('ts');
    expect(mocks.containerFetch).not.toHaveBeenCalled();
  });

  it('keeps listed routes on TypeScript while the switch is off', async () => {
    const response = await (
      await worker()
    ).fetch(
      new Request('http://localhost/system/go-probe', { headers: { host: 'localhost' } }),
      env({}),
      ctx,
    );
    expect(await response.text()).toBe('ts');
    expect(mocks.containerFetch).not.toHaveBeenCalled();
  });
});
