import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/bindings.ts';

const mocks = vi.hoisted(() => ({
  close: vi.fn(async () => {}),
  postgres: vi.fn(),
  fetch: vi.fn(),
  pendingMigrations: vi.fn(async () => [] as string[]),
  buildContainer: vi.fn(),
}));

vi.mock('../../api/src/platform/database/postgres.ts', () => ({ postgresClient: mocks.postgres }));
vi.mock('../src/migrations.ts', () => ({ MIGRATIONS: [] }));
vi.mock('../../api/src/platform/database/migrator.ts', () => ({
  pendingMigrations: mocks.pendingMigrations,
}));
vi.mock('../../api/src/compose.ts', () => ({ buildContainer: mocks.buildContainer }));
vi.mock('../../api/src/app.ts', () => ({ createApp: () => ({ fetch: mocks.fetch }) }));
vi.mock('../../api/src/contexts/documents/infrastructure/index.ts', () => ({
  inlineDocumentReader: {},
}));
vi.mock('../../api/src/contexts/identity/infrastructure/portable-password-hasher.ts', () => ({
  portablePasswordHasher: {},
}));

/** The bindings and variables a deployed Worker has; synthetic values only. */
const syntheticEnv = (vars: Record<string, string> = { SIPGES_ALLOWED_HOSTS: 'localhost' }) =>
  ({
    HYPERDRIVE: {
      connectionString: 'postgresql://synthetic:synthetic@binding.hyperdrive.local:5432/synthetic',
    },
    SIPGES_DATA_KEY: Buffer.alloc(32).toString('base64'),
    EVIDENCE: {},
    ASSETS: {},
    ...vars,
  }) as unknown as Env;

const ctx = { waitUntil: () => {} };
const request = () => new Request('http://localhost/health');

/** The initialized backend is cached per isolate: every case loads a fresh module. */
const freshWorker = async () => {
  vi.resetModules();
  return (await import('../src/index.ts')).default;
};

describe('Worker initialization through fetch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.postgres.mockReturnValue({ client: {}, close: mocks.close });
    mocks.pendingMigrations.mockResolvedValue([]);
    mocks.buildContainer.mockResolvedValue({ runtime: { scheduled: async () => {} } });
    mocks.fetch.mockImplementation(async () => new Response('ok'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('answers 503 without touching the database while SIPGES_ALLOWED_HOSTS is missing, then retries', async () => {
    const worker = await freshWorker();

    const failed = await worker.fetch(request(), syntheticEnv({}), ctx);

    expect(failed.status).toBe(503);
    expect(failed.headers.get('Cache-Control')).toBe('no-store');
    expect(mocks.pendingMigrations).not.toHaveBeenCalled();
    expect(mocks.buildContainer).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();

    const recovered = await worker.fetch(request(), syntheticEnv(), ctx);

    expect(recovered.status).toBe(200);
    expect(await recovered.text()).toBe('ok');
    expect(mocks.pendingMigrations).toHaveBeenCalledOnce();
    expect(mocks.buildContainer).toHaveBeenCalledOnce();
  });

  it('does not cache a failed container build: the next request initializes again', async () => {
    const worker = await freshWorker();
    mocks.buildContainer.mockRejectedValueOnce(new Error('synthetic build failure'));

    const failed = await worker.fetch(request(), syntheticEnv(), ctx);

    expect(failed.status).toBe(503);
    expect(mocks.fetch).not.toHaveBeenCalled();

    const recovered = await worker.fetch(request(), syntheticEnv(), ctx);

    expect(recovered.status).toBe(200);
    expect(mocks.buildContainer).toHaveBeenCalledTimes(2);
    expect(mocks.pendingMigrations).toHaveBeenCalledTimes(2);
  });

  it('keeps serving from the cached backend after a successful initialization', async () => {
    const worker = await freshWorker();

    await worker.fetch(request(), syntheticEnv(), ctx);
    await worker.fetch(request(), syntheticEnv(), ctx);

    expect(mocks.buildContainer).toHaveBeenCalledOnce();
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
  });

  it('shares one initialization between requests that arrive while it is running', async () => {
    const worker = await freshWorker();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    mocks.pendingMigrations.mockImplementation(async () => {
      await gate;
      return [];
    });

    const responses = Promise.all([
      worker.fetch(request(), syntheticEnv(), ctx),
      worker.fetch(request(), syntheticEnv(), ctx),
      worker.fetch(request(), syntheticEnv(), ctx),
    ]);
    await vi.waitFor(() => expect(mocks.pendingMigrations).toHaveBeenCalled());
    release?.();
    const settled = await responses;

    expect(settled.map((response) => response.status)).toEqual([200, 200, 200]);
    expect(mocks.pendingMigrations).toHaveBeenCalledOnce();
    expect(mocks.buildContainer).toHaveBeenCalledOnce();
    expect(mocks.fetch).toHaveBeenCalledTimes(3);
  });

  it('answers every concurrent request with 503 from one failed initialization, then retries once', async () => {
    const worker = await freshWorker();
    let fail: ((error: Error) => void) | undefined;
    const gate = new Promise<string[]>((_resolve, reject) => {
      fail = reject;
    });
    mocks.pendingMigrations.mockImplementationOnce(() => gate);

    const responses = Promise.all([
      worker.fetch(request(), syntheticEnv(), ctx),
      worker.fetch(request(), syntheticEnv(), ctx),
    ]);
    await vi.waitFor(() => expect(mocks.pendingMigrations).toHaveBeenCalled());
    fail?.(new Error('synthetic database outage'));
    const failed = await responses;

    expect(failed.map((response) => response.status)).toEqual([503, 503]);
    expect(mocks.pendingMigrations).toHaveBeenCalledOnce();

    const recovered = await worker.fetch(request(), syntheticEnv(), ctx);

    expect(recovered.status).toBe(200);
    expect(mocks.pendingMigrations).toHaveBeenCalledTimes(2);
    expect(mocks.buildContainer).toHaveBeenCalledOnce();
  });
});
