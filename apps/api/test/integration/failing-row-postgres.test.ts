import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadMigrations, migrate } from '../../src/platform/database/migrator.ts';
import { postgresClient } from '../../src/platform/database/postgres.ts';
import { TEST_ENV } from '../support/test-app.ts';

/**
 * The startup of apps/api/src/main.ts on a users CHECK violation, with the real process and
 * driver. Opt-in, like postgres.test.ts:
 *   SIPGES_TEST_DATABASE_URL=postgres://user@127.0.0.1:5432/postgres pnpm test
 */
const adminUrl = process.env.SIPGES_TEST_DATABASE_URL;
const PASSWORD = 'synthetic-password-01';
const HASH = '$argon2id$v=19$m=19456,t=2,p=1$c3ludGhldGljc2FsdA$synthetic';
const MAIN = fileURLToPath(new URL('../../src/main.ts', import.meta.url));

type Exit = { code: number | null; stderr: string };

const runMain = (env: Record<string, string>) =>
  new Promise<Exit>((resolve, reject) => {
    const child = spawn(process.execPath, [MAIN], {
      env: { PATH: process.env.PATH ?? '', ...TEST_ENV, ...env },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stderr }));
  });

describe.skipIf(!adminUrl)('a failing row on PostgreSQL', () => {
  const name = `sipges_test_${randomBytes(6).toString('hex')}`;
  let admin: postgres.Sql;
  let url: string;
  let pool: ReturnType<typeof postgresClient>;

  const failure = (work: Promise<unknown>) =>
    work.then(
      () => {
        throw new Error('the statement passed');
      },
      (error: unknown) => error as Error & { code?: string; detail?: string },
    );

  beforeAll(async () => {
    admin = postgres(adminUrl ?? '', { max: 1, onnotice: () => undefined });
    await admin.unsafe(`CREATE DATABASE ${name}`);
    const parsed = new URL(adminUrl ?? '');
    parsed.pathname = `/${name}`;
    url = parsed.toString();
    pool = postgresClient(url);
    await migrate(pool.client, await loadMigrations());
  });

  afterAll(async () => {
    await pool.close();
    await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.end();
  });

  it('stops main.ts as before, without the hash on stderr', async () => {
    const { code, stderr } = await runMain({
      SIPGES_DATABASE_URL: url,
      SIPGES_ADMIN_USERNAME: 'x'.repeat(121),
      SIPGES_ADMIN_PASSWORD: PASSWORD,
    });
    expect(code).toBe(1);
    expect(stderr).toContain('new row for relation "users" violates check constraint');
    expect(stderr).toContain('users_username_check');
    expect(stderr).toContain("code: '23514'");
    expect(stderr).not.toContain('$argon2id$');
    expect(stderr).not.toContain(PASSWORD);
    expect(stderr).not.toContain('Failing row contains (');
  });

  it('drops the row from every statement, in or out of a transaction', async () => {
    await pool.client.query(
      `INSERT INTO users (username, full_name, password_hash, role, totp_secret_sealed)
       VALUES ('row-holder', 'Synthetic', $1, 'analista', 'v1.synthetic-seal')`,
      [HASH],
    );
    const violate =
      "UPDATE users SET google_email = 'UPPER@EXAMPLE.ORG' WHERE username = 'row-holder'";
    const direct = await failure(pool.client.query(violate));
    const inside = await failure(pool.client.transaction((tx) => tx.query(violate)));
    const simple = await failure(pool.client.exec(violate));
    for (const error of [direct, inside, simple]) {
      expect(error.code).toBe('23514');
      expect(error.message).toContain('users_google_email_check');
      expect(error.detail).toBe('Failing row omitted');
    }
  });

  it('leaves the detail of other errors alone', async () => {
    const duplicate = await failure(
      pool.client.query(
        `INSERT INTO users (username, full_name, password_hash, role)
         VALUES ('row-holder', 'Synthetic', 'x', 'analista')`,
      ),
    );
    expect(duplicate.code).toBe('23505');
    expect(duplicate.detail).toContain('(username)=(row-holder)');
  });
});
