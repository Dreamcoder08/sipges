import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.ts';
import { buildContainer } from '../../src/compose.ts';
import { loadConfig } from '../../src/platform/config.ts';
import { loadMigrations, migrate } from '../../src/platform/database/migrator.ts';
import { postgresClient } from '../../src/platform/database/postgres.ts';
import { TEST_ENV, TestClock } from '../support/test-app.ts';

/**
 * Real PostgreSQL checks that single-connection PGlite cannot exercise: concurrent pools,
 * advisory locks and postgres.js parameter typing. Opt-in:
 *   SIPGES_TEST_DATABASE_URL=postgres://postgres:secret@127.0.0.1:55432/postgres pnpm test
 * A throwaway database is created per run and dropped afterwards.
 */
const adminUrl = process.env.SIPGES_TEST_DATABASE_URL;

describe.skipIf(!adminUrl)('PostgreSQL integration', () => {
  const name = `sipges_test_${randomBytes(6).toString('hex')}`;
  let admin: postgres.Sql;
  let url: string;
  const pools: { close: () => Promise<void> }[] = [];

  const open = () => {
    const pool = postgresClient(url);
    pools.push(pool);
    return pool.client;
  };

  beforeAll(async () => {
    admin = postgres(adminUrl ?? '', { max: 1 });
    await admin.unsafe(`CREATE DATABASE ${name}`);
    const parsed = new URL(adminUrl ?? '');
    parsed.pathname = `/${name}`;
    url = parsed.toString();
  });

  afterAll(async () => {
    await Promise.all(pools.map((p) => p.close()));
    await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.end();
  });

  it('applies every migration exactly once when two instances start together', async () => {
    const migrations = await loadMigrations();
    const [a, b] = await Promise.all([migrate(open(), migrations), migrate(open(), migrations)]);
    expect([...a, ...b].sort()).toEqual(migrations.map((m) => m.version));
    const rows = await open().query<{ version: string }>(
      'SELECT version FROM schema_migrations ORDER BY version',
    );
    expect(rows.map((r) => r.version)).toEqual(migrations.map((m) => m.version));
  });

  it('holds the login throttle under real parallel connections', async () => {
    const sql = open();
    const container = await buildContainer({
      config: loadConfig(TEST_ENV),
      sql,
      clock: new TestClock(),
      clientIp: () => '203.0.113.50',
    });
    const app = createApp(container);
    const attempt = () =>
      app.request('/login', {
        method: 'POST',
        headers: { host: 'localhost', origin: 'http://localhost' },
        body: new URLSearchParams({ username: 'admin', password: 'wrong-wrong-wrong' }),
      });

    const statuses = (await Promise.all(Array.from({ length: 30 }, attempt))).map((r) => r.status);
    expect(statuses.filter((s) => s === 401)).toHaveLength(5);
    expect(statuses.filter((s) => s === 429)).toHaveLength(25);

    const ok = await app.request('/login', {
      method: 'POST',
      headers: { host: 'localhost', origin: 'http://localhost', 'x-forwarded-for': 'ignored' },
      body: new URLSearchParams({ username: 'admin', password: 'admin-password-123' }),
    });
    expect(ok.status).toBe(429);
  });
});
