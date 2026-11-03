import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildContainer } from '../../src/compose.ts';
import { loadConfig } from '../../src/platform/config.ts';
import { loadMigrations, migrate } from '../../src/platform/database/migrator.ts';
import { postgresClient } from '../../src/platform/database/postgres.ts';
import { TEST_ENV, TestClock } from '../support/test-app.ts';

/**
 * ADR 0010 bootstrap under concurrency: every Worker cold start runs bootstrapGoogleAdmin, so an
 * administrator may link an address while a start is in flight. Opt-in, like postgres.test.ts:
 *   SIPGES_TEST_DATABASE_URL=postgres://user@127.0.0.1:5432/postgres pnpm test
 */
const adminUrl = process.env.SIPGES_TEST_DATABASE_URL;

const GOOGLE_ENV = {
  SIPGES_GOOGLE_CLIENT_ID: 'client.apps.example',
  SIPGES_GOOGLE_CLIENT_SECRET: 'synthetic-secret',
  SIPGES_GOOGLE_ADMIN_EMAIL: 'bootstrap.sintetico@example.com',
};
const LINKED = 'enlazado.sintetico@example.com';
const GOOGLE_TOKEN = 'a'.repeat(64);

describe.skipIf(!adminUrl)('Google bootstrap on PostgreSQL', () => {
  const name = `sipges_test_${randomBytes(6).toString('hex')}`;
  let admin: postgres.Sql;
  let url: string;
  const closers: (() => Promise<void>)[] = [];

  const open = () => {
    const pool = postgresClient(url);
    closers.push(() => pool.close());
    return pool.client;
  };
  const raw = () => {
    const sql = postgres(url, { max: 1, onnotice: () => undefined });
    closers.push(() => sql.end());
    return sql;
  };
  const start = (env: Record<string, string> = {}) =>
    buildContainer({
      config: loadConfig({ ...TEST_ENV, ...env }),
      sql: open(),
      clock: new TestClock(),
      clientIp: () => '203.0.113.60',
    });

  beforeAll(async () => {
    admin = postgres(adminUrl ?? '', { max: 1, onnotice: () => undefined });
    await admin.unsafe(`CREATE DATABASE ${name}`);
    const parsed = new URL(adminUrl ?? '');
    parsed.pathname = `/${name}`;
    url = parsed.toString();
    await migrate(open(), await loadMigrations());
    await start(); // creates the bootstrap administrator, without a Google address
  });

  afterAll(async () => {
    await Promise.all(closers.map((close) => close()));
    await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.end();
  });

  /** Starts a cold start while `hold` keeps an uncommitted change, committing once it waits. */
  const coldStartDuring = async (hold: (tx: postgres.TransactionSql) => Promise<unknown>) => {
    const observer = raw();
    let cold: Promise<unknown> = Promise.resolve();
    await raw().begin(async (tx) => {
      await hold(tx);
      cold = start(GOOGLE_ENV);
      for (let i = 0; i < 200; i++) {
        const [waiting] = await observer`
          SELECT count(*)::int AS n FROM pg_stat_activity
           WHERE datname = ${name} AND wait_event_type = 'Lock'`;
        if (waiting?.n) return;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error('the cold start never waited on the uncommitted change');
    });
    await cold;
  };

  const db = () => raw();
  const adminEmail = async () =>
    (await db()`SELECT google_email FROM users WHERE username = 'admin'`)[0]?.google_email;
  const googleSessions = async () =>
    (await db()`SELECT 1 FROM sessions WHERE token_hash = ${GOOGLE_TOKEN}`).length;
  const reset = async (email: string | null) => {
    const sql = db();
    await sql`DELETE FROM sessions`;
    await sql`DELETE FROM users WHERE username <> 'admin'`;
    await sql`UPDATE users SET google_email = ${email} WHERE username = 'admin'`;
  };
  const addGoogleSession = (sql: postgres.Sql | postgres.TransactionSql) =>
    sql`INSERT INTO sessions (token_hash, username, expires_at, via_google)
        VALUES (${GOOGLE_TOKEN}, 'admin', now() + interval '1 hour', true)`;
  const addOtherUser = (sql: postgres.Sql | postgres.TransactionSql, email: string) =>
    sql`INSERT INTO users (username, full_name, password_hash, role, google_email)
        SELECT 'otra', 'Otra Sintética', password_hash, 'consulta', ${email}
          FROM users WHERE username = 'admin'`;

  it('keeps the address and Google sessions an administrator links during a cold start', async () => {
    await reset(null);
    await coldStartDuring(async (tx) => {
      await tx`UPDATE users SET google_email = ${LINKED} WHERE username = 'admin'`;
      await addGoogleSession(tx);
    });
    expect(await adminEmail()).toBe(LINKED);
    expect(await googleSessions()).toBe(1);
  });

  it('links an address-less administrator once when many cold starts run together', async () => {
    await reset(null);
    await Promise.all(Array.from({ length: 12 }, () => start(GOOGLE_ENV)));
    expect(await adminEmail()).toBe(GOOGLE_ENV.SIPGES_GOOGLE_ADMIN_EMAIL);
  });

  it('keeps Google sessions when the configured address is already linked', async () => {
    await reset(GOOGLE_ENV.SIPGES_GOOGLE_ADMIN_EMAIL);
    await addGoogleSession(db());
    await start(GOOGLE_ENV);
    expect(await adminEmail()).toBe(GOOGLE_ENV.SIPGES_GOOGLE_ADMIN_EMAIL);
    expect(await googleSessions()).toBe(1);
  });

  it('never replaces a different address an administrator set, nor its sessions', async () => {
    await reset(LINKED);
    await addGoogleSession(db());
    await start(GOOGLE_ENV);
    expect(await adminEmail()).toBe(LINKED);
    expect(await googleSessions()).toBe(1);
  });

  it('leaves the administrator unlinked when another account holds the address', async () => {
    await reset(null);
    await addOtherUser(db(), GOOGLE_ENV.SIPGES_GOOGLE_ADMIN_EMAIL);
    await start(GOOGLE_ENV);
    expect(await adminEmail()).toBeNull();
  });

  it('reports a held address only while the administrator is still unlinked', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await reset(LINKED);
      await addOtherUser(db(), GOOGLE_ENV.SIPGES_GOOGLE_ADMIN_EMAIL);
      await start(GOOGLE_ENV);
      expect(errors).not.toHaveBeenCalled();
      await db()`UPDATE users SET google_email = NULL WHERE username = 'admin'`;
      await start(GOOGLE_ENV);
      expect(errors).toHaveBeenCalledWith(
        'SIPGES_GOOGLE_ADMIN_EMAIL is already linked to another account',
      );
    } finally {
      errors.mockRestore();
    }
  });

  it('starts unlinked when another account takes the address during the cold start', async () => {
    await reset(null);
    // The uncommitted row makes the unique index wait, then report a violation on commit.
    await coldStartDuring((tx) => addOtherUser(tx, GOOGLE_ENV.SIPGES_GOOGLE_ADMIN_EMAIL));
    expect(await adminEmail()).toBeNull();
  });
});
