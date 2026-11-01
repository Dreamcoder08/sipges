import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/bindings.ts';

const mocks = vi.hoisted(() => ({
  close: vi.fn(async () => {}),
  postgres: vi.fn(),
  fetch: vi.fn(),
  scheduled: vi.fn(async () => {}),
  migrate: vi.fn(async () => [] as string[]),
  pendingMigrations: vi.fn(async () => [] as string[]),
  buildContainer: vi.fn(),
  // The container is built once per isolate, so its dependencies are kept across cases.
  built: { deps: undefined as unknown },
}));

vi.mock('../../api/src/platform/database/postgres.ts', () => ({ postgresClient: mocks.postgres }));
vi.mock('../src/migrations.ts', () => ({ MIGRATIONS: [] }));
vi.mock('../../api/src/platform/database/migrator.ts', () => ({
  migrate: mocks.migrate,
  pendingMigrations: mocks.pendingMigrations,
}));
vi.mock('../../api/src/compose.ts', () => ({
  buildContainer: mocks.buildContainer,
}));
vi.mock('../../api/src/app.ts', () => ({ createApp: () => ({ fetch: mocks.fetch }) }));
vi.mock('../../api/src/contexts/documents/infrastructure/index.ts', () => ({
  inlineDocumentReader: {},
}));
vi.mock('../../api/src/contexts/identity/infrastructure/portable-password-hasher.ts', () => ({
  portablePasswordHasher: {},
}));

import worker from '../src/index.ts';

/** The bindings and variables a deployed Worker has; synthetic values only. */
const syntheticEnv = () =>
  ({
    HYPERDRIVE: {
      connectionString: 'postgresql://synthetic:synthetic@binding.hyperdrive.local:5432/synthetic',
    },
    SIPGES_ALLOWED_HOSTS: 'localhost',
    SIPGES_DATA_KEY: Buffer.alloc(32).toString('base64'),
    EVIDENCE: {},
    ASSETS: {},
  }) as unknown as Env;

describe('Worker Hyperdrive connection', () => {
  // Each case starts from fresh mocks, so the cases pass in any order or alone.
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.postgres.mockReturnValue({ client: {}, close: mocks.close });
    mocks.pendingMigrations.mockResolvedValue([]);
    mocks.buildContainer.mockImplementation(async (deps: unknown) => {
      mocks.built.deps = deps;
      return { runtime: { scheduled: mocks.scheduled } };
    });
  });

  it('uses the Hyperdrive socket without client TLS and closes after the response stream ends', async () => {
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    mocks.fetch.mockResolvedValue(
      new Response(
        new ReadableStream<Uint8Array>({
          start(value) {
            controller = value;
          },
        }),
      ),
    );
    const pending: Promise<unknown>[] = [];
    const env = syntheticEnv();
    const response = await worker.fetch(new Request('http://localhost/health'), env, {
      waitUntil: (promise) => {
        pending.push(promise);
      },
    });
    expect(response.status).toBe(200);
    expect(mocks.postgres).toHaveBeenCalledWith(env.HYPERDRIVE.connectionString, {
      max: 5,
      prepare: true,
      ssl: false,
    });
    expect(mocks.close).not.toHaveBeenCalled();
    const body = response.text();
    controller?.close();
    await body;
    await Promise.all(pending);
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it('still runs scheduled work and closes its connection', async () => {
    const pending: Promise<unknown>[] = [];
    const env = syntheticEnv();
    await worker.scheduled({}, env, {
      waitUntil: (promise) => {
        pending.push(promise);
      },
    });
    await Promise.all(pending);
    expect(mocks.scheduled).toHaveBeenCalledOnce();
    expect(mocks.postgres).toHaveBeenCalledWith(env.HYPERDRIVE.connectionString, {
      max: 5,
      prepare: true,
      ssl: false,
    });
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it('serves the repository references from the bundle, since Workers have no filesystem', async () => {
    const pending: Promise<unknown>[] = [];
    await worker.scheduled({}, syntheticEnv(), {
      waitUntil: (promise) => {
        pending.push(promise);
      },
    });
    await Promise.all(pending);
    const deps = mocks.built.deps as
      { referenceReader?: { coordinates: (scope: unknown) => Promise<unknown> } } | undefined;
    expect(deps?.referenceReader).toBeDefined();
    await expect(
      deps?.referenceReader?.coordinates({ companyId: 'SIPGES', projectId: 'PRJ-SECHURA' }),
    ).resolves.toMatchObject({ crs: { geometry: 'EPSG:4326' } });
  });

  it('never migrates at request time and answers 503 while migrations are pending', async () => {
    // The backend is cached per isolate: load a fresh module so initialization runs again.
    vi.resetModules();
    const { default: fresh } = await import('../src/index.ts');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.pendingMigrations.mockResolvedValue(['0029_next']);
    const pending: Promise<unknown>[] = [];
    const response = await fresh.fetch(new Request('http://localhost/health'), syntheticEnv(), {
      waitUntil: (promise) => {
        pending.push(promise);
      },
    });
    await Promise.all(pending);
    expect(response.status).toBe(503);
    expect(mocks.migrate).not.toHaveBeenCalled();
    expect(mocks.buildContainer).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it('serves once the pending migrations have been applied by the deploy', async () => {
    // The backend is cached per isolate: load a fresh module so initialization runs again.
    vi.resetModules();
    const { default: fresh } = await import('../src/index.ts');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.fetch.mockResolvedValue(new Response('ok'));
    const waitUntil = () => {};
    mocks.pendingMigrations.mockResolvedValueOnce(['0029_next']);
    const first = await fresh.fetch(new Request('http://localhost/health'), syntheticEnv(), {
      waitUntil,
    });
    expect(first.status).toBe(503);
    const second = await fresh.fetch(new Request('http://localhost/health'), syntheticEnv(), {
      waitUntil,
    });
    expect(second.status).toBe(200);
    expect(mocks.migrate).not.toHaveBeenCalled();
    error.mockRestore();
  });
});
