import { PGlite } from '@electric-sql/pglite';
import { afterAll } from 'vitest';
import { trackTestDatabase } from './test-database.ts';
import { buildContainer } from '../../src/compose.ts';
import type { ObjectStorage } from '../../src/contexts/evidence/application/index.ts';
import { createApp } from '../../src/app.ts';
import { loadConfig } from '../../src/platform/config.ts';
import { loadMigrations, migrate } from '../../src/platform/database/migrator.ts';
import { pgliteClient } from '../../src/platform/database/pglite.ts';

/** Fixed synthetic key for tests only (32 zero-to-31 bytes). */
export const TEST_DATA_KEY = Buffer.from(Array.from({ length: 32 }, (_, i) => i)).toString(
  'base64',
);

export const TEST_ENV = {
  MASCLI_DATA_KEY: TEST_DATA_KEY,
  MASCLI_ADMIN_USERNAME: 'admin',
  MASCLI_ADMIN_PASSWORD: 'admin-password-123',
} as const;

export const ORIGIN = 'http://localhost';

/** Mutable clock so tests can move time forward deterministically. */
export class TestClock {
  #now: Date;
  constructor(start = new Date('2026-10-12T12:00:00Z')) {
    this.#now = start;
  }
  now = () => new Date(this.#now);
  advance(seconds: number) {
    this.#now = new Date(this.#now.getTime() + seconds * 1000);
  }
}

// One migrated template per test file; every test gets an isolated clone of it.
let template: Promise<PGlite> | undefined;
const migratedTemplate = () =>
  (template ??= (async () => {
    const db = new PGlite();
    try {
      await migrate(pgliteClient(db), await loadMigrations());
      return db;
    } catch (error) {
      await db.close();
      throw error;
    }
  })());

afterAll(async () => {
  if (!template) return;
  // A failed migration already closes its allocation in migratedTemplate.
  const db = await template.catch(() => undefined);
  if (db && !db.closed) await db.close();
});

/** In-memory object storage; `objects` lets tests inspect what was stored or removed. */
export const memoryStorage = () => {
  const objects = new Map<string, Uint8Array>();
  const storage: ObjectStorage = {
    put: async (key, bytes) => void objects.set(key, new Uint8Array(bytes)),
    get: async (key) => objects.get(key) ?? null,
    delete: async (key) => void objects.delete(key),
  };
  return { objects, storage };
};

export const createTestApp = async (
  env: Record<string, string> = {},
  options: { objectStorage?: ObjectStorage } = {},
) => {
  const db = trackTestDatabase(await (await migratedTemplate()).clone());
  const sql = pgliteClient(db);
  const clock = new TestClock();
  const config = loadConfig({ ...TEST_ENV, ...env });
  const memory = memoryStorage();
  const container = await buildContainer({
    config,
    sql,
    clock,
    clientIp: (c) => c.req.header('x-test-ip') ?? '203.0.113.1',
    objectStorage: options.objectStorage ?? memory.storage,
  });
  const app = createApp(container);

  const request = (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    if (!headers.has('host')) headers.set('host', 'localhost');
    return app.request(path, { ...init, headers });
  };

  const form = (fields: Record<string, string>) => new URLSearchParams(fields);

  const login = async (username: string, password: string, otp = '') => {
    const res = await request('/login', {
      method: 'POST',
      body: form({ username, password, otp }),
    });
    const cookie = res.headers.get('set-cookie') ?? '';
    const token = /mascli_session=([^;]*)/.exec(cookie)?.[1] ?? '';
    return { res, token, cookie: `mascli_session=${token}` };
  };

  const createAccount = async (
    adminCookie: string,
    account: { username: string; full_name: string; password: string; role: string },
  ) =>
    request('/system/auth/accounts', {
      method: 'POST',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify(account),
    });

  const grant = async (adminCookie: string, username: string, scope = 'MASCLI/PRJ-SECHURA') => {
    const [company_id, project_id] = scope.split('/');
    const res = await request('/system/auth/grants', {
      method: 'POST',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ username, company_id, project_id }),
    });
    if (res.status !== 200) throw new Error(`grant failed: ${res.status} ${await res.text()}`);
  };

  const createScope = async (
    adminCookie: string,
    body: { company_id: string; project_id: string; label: string; username: string },
  ) =>
    request('/system/auth/scopes', {
      method: 'POST',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  return {
    app,
    db,
    sql,
    clock,
    objects: memory.objects,
    request,
    form,
    login,
    createAccount,
    grant,
    createScope,
  };
};
