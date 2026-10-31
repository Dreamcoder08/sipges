import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/bindings.ts';

const mocks = vi.hoisted(() => ({
  close: vi.fn(async () => {}),
  postgres: vi.fn(),
  fetch: vi.fn(),
  scheduled: vi.fn(async () => {}),
}));

vi.mock('../../api/src/platform/database/postgres.ts', () => ({ postgresClient: mocks.postgres }));
vi.mock('../src/migrations.ts', () => ({ MIGRATIONS: [] }));
vi.mock('../../api/src/platform/database/migrator.ts', () => ({ migrate: vi.fn(async () => []) }));
vi.mock('../../api/src/compose.ts', () => ({
  buildContainer: vi.fn(async () => ({ runtime: { scheduled: mocks.scheduled } })),
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
    MASCLI_ALLOWED_HOSTS: 'localhost',
    MASCLI_DATA_KEY: Buffer.alloc(32).toString('base64'),
    EVIDENCE: {},
    ASSETS: {},
  }) as unknown as Env;

describe('Worker Hyperdrive connection', () => {
  // Each case starts from fresh mocks, so the cases pass in any order or alone.
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.postgres.mockReturnValue({ client: {}, close: mocks.close });
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
});
