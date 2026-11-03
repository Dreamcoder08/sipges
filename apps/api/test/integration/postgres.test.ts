import { randomBytes } from 'node:crypto';
import { connect, createServer } from 'node:net';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.ts';
import { buildContainer } from '../../src/compose.ts';
import { loadConfig } from '../../src/platform/config.ts';
import { loadMigrations, migrate } from '../../src/platform/database/migrator.ts';
import { createSqlRecordStore } from '../../src/contexts/records/infrastructure/sql-record-store.ts';
import { postgresClient } from '../../src/platform/database/postgres.ts';
import { withTenant } from '../../src/platform/database/tenant-transaction.ts';
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

  it('imports a batch across several insert statements under the tenant role', async () => {
    // The batched insert relies on postgres.js serializing one JSON parameter; PGlite does not
    // exercise that driver or the non-superuser role that enforces row-level security.
    const sql = open();
    await buildContainer({
      config: loadConfig(TEST_ENV),
      sql,
      clock: new TestClock(),
      clientIp: () => '203.0.113.10',
    });
    const tenant = 'SIPGES/PRJ-SECHURA';
    const store = createSqlRecordStore(sql);
    const at = new Date('2026-11-02T12:00:00Z');
    const note = { action: 'IMPORT', detail: 'Importación sintética' } as const;
    await store.importBatch(tenant, 'Eventos', [{ id: 'EV-0', payload: { a: 'x' } }], note, at);
    const items = Array.from({ length: 1200 }, (_, i) => ({
      id: `EV-${i}`,
      payload: { n: i, texto: `«${i}» "\\" ñ` },
    }));
    expect(await store.importBatch(tenant, 'Eventos', items, note, at)).toEqual({
      created: 1199,
      updated: 1,
    });
    const [summary] = await withTenant(sql, tenant, (tx) =>
      tx.query<{ total: number; first: Record<string, unknown>; last: Record<string, unknown> }>(
        `SELECT count(*)::int AS total,
                (SELECT payload FROM module_records WHERE module = 'Eventos' AND id = 'EV-0') AS first,
                (SELECT payload FROM module_records WHERE module = 'Eventos' AND id = 'EV-1199') AS last
         FROM module_records WHERE module = 'Eventos'`,
      ),
    );
    expect(summary).toEqual({
      total: 1200,
      first: { a: 'x', n: 0, texto: '«0» "\\" ñ' },
      last: { n: 1199, texto: '«1199» "\\" ñ' },
    });
  });

  it('opens a connection without querying the type catalogue', async () => {
    // The Worker opens a client per request: a type-catalogue query on connect would add a
    // round trip to every request. SIPGES declares no custom types, so built-ins suffice.
    const target = new URL(url);
    let sent = '';
    const server = createServer((client) => {
      const upstream = connect(Number(target.port || 5432), target.hostname);
      client.on('data', (chunk: Buffer) => {
        sent += chunk.toString('latin1');
        upstream.write(chunk);
      });
      upstream.on('data', (chunk: Buffer) => client.write(chunk));
      client.on('close', () => upstream.destroy());
      upstream.on('close', () => client.destroy());
      client.on('error', () => upstream.destroy());
      upstream.on('error', () => client.destroy());
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const proxied = new URL(url);
    proxied.hostname = '127.0.0.1';
    proxied.port = String(typeof address === 'object' && address ? address.port : 0);
    const fresh = postgresClient(proxied.toString(), { max: 1 });
    try {
      // Without the catalogue, arrays of built-in types still decode to JavaScript arrays.
      const rows = await fresh.client.query<Record<string, unknown>>(
        `SELECT $1::integer[] AS ids, $2::text[] AS words, array[9]::bigint[] AS bigs,
                array[1.5]::real[] AS reals, array[true, false] AS flags,
                array['{"a":1}'::jsonb] AS docs, array['2026-11-02T12:00:00Z'::timestamptz] AS times,
                array['a b', 'c"d', null]::text[] AS quoted`,
        [
          [1, 2],
          ['x', 'y,z', 'é'],
        ],
      );
      expect(rows).toEqual([
        {
          ids: [1, 2],
          words: ['x', 'y,z', 'é'],
          bigs: ['9'],
          reals: [1.5],
          flags: [true, false],
          docs: [{ a: 1 }],
          times: [new Date('2026-11-02T12:00:00Z')],
          quoted: ['a b', 'c"d', null],
        },
      ]);
      expect(sent).not.toContain('pg_type');
    } finally {
      await fresh.close();
      server.close();
    }
  });

  it('sends a query whose parameters are all cast in one message', async () => {
    // A parameter of unknown type makes postgres.js wait for the server to describe the
    // statement before sending values: two round trips instead of one.
    const target = new URL(url);
    let writes = 0;
    const server = createServer((client) => {
      const upstream = connect(Number(target.port || 5432), target.hostname);
      client.on('data', (chunk: Buffer) => {
        writes++;
        upstream.write(chunk);
      });
      upstream.on('data', (chunk: Buffer) => client.write(chunk));
      client.on('close', () => upstream.destroy());
      upstream.on('close', () => client.destroy());
      client.on('error', () => upstream.destroy());
      upstream.on('error', () => client.destroy());
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const proxied = new URL(url);
    proxied.hostname = '127.0.0.1';
    proxied.port = String(typeof address === 'object' && address ? address.port : 0);
    const fresh = postgresClient(proxied.toString(), { max: 1 });
    try {
      await fresh.client.query('SELECT 1');
      const at = new Date('2026-11-02T12:00:00.123Z');
      writes = 0;
      const rows = await fresh.client.query<Record<string, unknown>>(
        `SELECT $1::text AS t, $2::timestamptz AS at, $3::integer AS n, $4::boolean AS b,
                $5::bigint AS big, $6::text AS missing`,
        ['token', at, 7, true, 9, null],
      );
      expect(writes).toBe(1);
      expect(rows).toEqual([{ t: 'token', at, n: 7, b: true, big: '9', missing: null }]);
      writes = 0;
      await fresh.client.query('SELECT $1 AS bare', ['x']);
      expect(writes).toBe(2);
    } finally {
      await fresh.close();
      server.close();
    }
  });
});
