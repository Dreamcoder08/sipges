import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, describe, expect, it } from 'vitest';
import { createSecretCipher } from '../../src/contexts/identity/infrastructure/secret-cipher.ts';
import { totp } from '../../src/contexts/identity/infrastructure/totp.ts';
import { loadConfig } from '../../src/platform/config.ts';
import { loadMigrations, migrate } from '../../src/platform/database/migrator.ts';
import { pgliteClient } from '../../src/platform/database/pglite.ts';
import type { SqlClient } from '../../src/platform/database/sql-client.ts';
import { withTenant } from '../../src/platform/database/tenant-transaction.ts';
import {
  type RotationReport,
  TARGETS,
  rotateDataKey,
  summarize,
} from '../../src/tools/rotate-data-key/rotate.ts';
import { main, parseCliArgs } from '../../src/tools/rotate-data-key/cli.ts';
import { TEST_DATA_KEY, TEST_ENV, createTestApp } from '../support/test-app.ts';
import { trackTestDatabase } from '../support/test-database.ts';

// Synthetic keys and values only.
const OLD_KEY = Buffer.alloc(32, 1);
const NEW_KEY = Buffer.alloc(32, 2);
const TENANTS = [
  ['acme', 'norte'],
  ['acme', 'sur'],
] as const;
const TOTP = { ana: 'JBSWY3DPEHPK3PXP', beto: 'GEZDGNBVGY3TQOJQ' } as const;
const channelConfig = (tenant: string) => JSON.stringify({ url: `https://hooks.test/${tenant}` });

// One migrated template per file; every test seeds an isolated clone of it.
let template: Promise<PGlite> | undefined;
const migratedTemplate = () =>
  (template ??= (async () => {
    const db = new PGlite();
    await migrate(pgliteClient(db), await loadMigrations());
    return db;
  })());
afterAll(async () => {
  const db = await template?.catch(() => undefined);
  if (db && !db.closed) await db.close();
});
const migratedClone = async () => trackTestDatabase(await (await migratedTemplate()).clone());

const seed = async (key: Buffer = OLD_KEY, db?: PGlite): Promise<SqlClient> => {
  const sql = pgliteClient(db ?? (await migratedClone()));
  if (db) await migrate(sql, await loadMigrations());
  const cipher = createSecretCipher(key);
  for (const [company, project] of TENANTS) {
    await sql.query(
      `INSERT INTO tenants (company_id, project_id, label) VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING`,
      [company, project, `${company} ${project}`],
    );
  }
  for (const [username, secret] of Object.entries(TOTP)) {
    await sql.query(
      `INSERT INTO users (username, full_name, password_hash, role, totp_secret_sealed, totp_enabled)
       VALUES ($1, $1, 'synthetic-hash', 'analista', $2, true)`,
      [username, cipher.seal(secret)],
    );
  }
  await sql.query(
    `INSERT INTO users (username, full_name, password_hash, role) VALUES ('sin-mfa', 'x', 'h', 'consulta')`,
  );
  for (const [company, project] of TENANTS) {
    const tenantId = `${company}/${project}`;
    await withTenant(sql, tenantId, (tx) =>
      tx.query(
        `INSERT INTO integration_channels (tenant_id, kind, name, sealed_config, created_by, created_at)
         VALUES ($1, 'webhook', 'avisos', $2, 'ana', now())`,
        [tenantId, cipher.seal(channelConfig(tenantId))],
      ),
    );
  }
  return sql;
};

/** Every sealed value, tenant-owned rows included (read through each tenant's RLS scope). */
const sealedValues = async (sql: SqlClient): Promise<string[]> => {
  const users = await sql.query<{ v: string }>(
    'SELECT totp_secret_sealed AS v FROM users WHERE totp_secret_sealed IS NOT NULL ORDER BY username',
  );
  const channels: string[] = [];
  for (const [company, project] of TENANTS) {
    const rows = await withTenant(sql, `${company}/${project}`, (tx) =>
      tx.query<{ v: string }>('SELECT sealed_config AS v FROM integration_channels ORDER BY id'),
    );
    channels.push(...rows.map((row) => row.v));
  }
  return [...users.map((row) => row.v), ...channels];
};

/** Hash of every whole row in both tables (each tenant's channels through its RLS scope). */
const fingerprint = async (sql: SqlClient): Promise<string> => {
  const hashes = await sql.query<{ h: string | null }>(
    "SELECT md5(string_agg(u::text, '|' ORDER BY username)) AS h FROM users u",
  );
  for (const [company, project] of TENANTS) {
    hashes.push(
      ...(await withTenant(sql, `${company}/${project}`, (tx) =>
        tx.query<{ h: string | null }>(
          "SELECT md5(string_agg(c::text, '|' ORDER BY id)) AS h FROM integration_channels c",
        ),
      )),
    );
  }
  return hashes.map((row) => row.h ?? '').join('|');
};

const total = (report: RotationReport, field: 'stale' | 'current' | 'rewritten' | 'unreadable') =>
  report.columns.reduce((sum, column) => sum + column[field], 0);

describe('SIPGES_DATA_KEY rotation tool', () => {
  it('covers every sealed column in the schema', async () => {
    const sql = pgliteClient(await migratedClone());
    const columns = await sql.query<{ name: string }>(
      `SELECT table_name || '.' || column_name AS name FROM information_schema.columns
       WHERE table_schema = 'public' AND column_name LIKE '%sealed%' ORDER BY 1`,
    );
    expect(columns.map((c) => c.name)).toEqual(TARGETS.map((t) => `${t.table}.${t.column}`).sort());
  });

  it('dry-run reports counts per table and column and changes nothing', async () => {
    const sql = await seed();
    const before = await fingerprint(sql);

    const report = await rotateDataKey(sql, { oldKey: OLD_KEY, newKey: NEW_KEY, mode: 'dry-run' });

    expect(report.ok).toBe(true);
    expect(report.columns).toEqual([
      expect.objectContaining({
        table: 'users',
        column: 'totp_secret_sealed',
        scope: 'global',
        total: 2,
        stale: 2,
        current: 0,
        unreadable: 0,
        rewritten: 0,
      }),
      ...TENANTS.map(([company, project]) =>
        expect.objectContaining({
          table: 'integration_channels',
          column: 'sealed_config',
          scope: `${company}/${project}`,
          total: 1,
          stale: 1,
          rewritten: 0,
        }),
      ),
    ]);
    expect(await fingerprint(sql)).toBe(before);
  });

  it('--apply re-encrypts every value with the new key and keeps the plaintext', async () => {
    const sql = await seed();
    const report = await rotateDataKey(sql, { oldKey: OLD_KEY, newKey: NEW_KEY, mode: 'apply' });

    expect(report.ok).toBe(true);
    expect(total(report, 'rewritten')).toBe(4);
    const fresh = createSecretCipher(NEW_KEY);
    const opened = (await sealedValues(sql)).map((value) => fresh.open(value));
    expect(opened).toEqual([
      TOTP.ana,
      TOTP.beto,
      ...TENANTS.map(([c, p]) => channelConfig(`${c}/${p}`)),
    ]);
    for (const value of await sealedValues(sql)) {
      expect(() => createSecretCipher(OLD_KEY).open(value)).toThrow();
    }
  });

  it('re-running after success is a no-op', async () => {
    const sql = await seed();
    await rotateDataKey(sql, { oldKey: OLD_KEY, newKey: NEW_KEY, mode: 'apply' });
    const after = await fingerprint(sql);

    const again = await rotateDataKey(sql, { oldKey: OLD_KEY, newKey: NEW_KEY, mode: 'apply' });

    expect(again.ok).toBe(true);
    expect(total(again, 'current')).toBe(4);
    expect(total(again, 'stale')).toBe(0);
    expect(total(again, 'rewritten')).toBe(0);
    expect(await fingerprint(sql)).toBe(after);
  });

  it('resumes a partial rotation, rewriting only what is still stale', async () => {
    const sql = await seed();
    // One value already carries the new key, as after an interrupted run or a fresh enrollment.
    await sql.query('UPDATE users SET totp_secret_sealed = $1 WHERE username = $2', [
      createSecretCipher(NEW_KEY).seal(TOTP.ana),
      'ana',
    ]);

    const report = await rotateDataKey(sql, { oldKey: OLD_KEY, newKey: NEW_KEY, mode: 'apply' });

    expect(report.ok).toBe(true);
    expect(total(report, 'current')).toBe(1);
    expect(total(report, 'rewritten')).toBe(3);
    const fresh = createSecretCipher(NEW_KEY);
    expect((await sealedValues(sql)).map((value) => fresh.open(value))[0]).toBe(TOTP.ana);
  });

  it('a wrong old key aborts without writing anything', async () => {
    const sql = await seed();
    const before = await fingerprint(sql);

    const report = await rotateDataKey(sql, {
      oldKey: randomBytes(32),
      newKey: NEW_KEY,
      mode: 'apply',
    });

    expect(report.ok).toBe(false);
    expect(total(report, 'unreadable')).toBe(4);
    expect(total(report, 'rewritten')).toBe(0);
    expect(report.problem).toMatch(/cannot be opened with either key/);
    expect(await fingerprint(sql)).toBe(before);
  });

  it('one unreadable value anywhere aborts the whole run before any write', async () => {
    const sql = await seed();
    await withTenant(sql, 'acme/sur', (tx) =>
      tx.query('UPDATE integration_channels SET sealed_config = $1', [
        createSecretCipher(randomBytes(32)).seal('{}'),
      ]),
    );
    const before = await fingerprint(sql);

    const report = await rotateDataKey(sql, { oldKey: OLD_KEY, newKey: NEW_KEY, mode: 'apply' });

    expect(report.ok).toBe(false);
    expect(report.columns.find((c) => c.scope === 'acme/sur')).toMatchObject({
      unreadable: 1,
      unreadableIds: ['2'],
    });
    expect(await fingerprint(sql)).toBe(before);
  });

  it('refuses identical old and new keys', async () => {
    const sql = await seed();
    await expect(
      rotateDataKey(sql, { oldKey: OLD_KEY, newKey: Buffer.from(OLD_KEY), mode: 'apply' }),
    ).rejects.toThrow('The old and new data keys must differ');
  });

  it('never prints plaintext or keys in its summary', async () => {
    const sql = await seed();
    const report = await rotateDataKey(sql, { oldKey: OLD_KEY, newKey: NEW_KEY, mode: 'apply' });
    const text = summarize(report);

    expect(text).toContain('integration_channels.sealed_config');
    for (const secret of [
      ...Object.values(TOTP),
      'hooks.test',
      OLD_KEY.toString('base64'),
      NEW_KEY.toString('base64'),
    ]) {
      expect(text).not.toContain(secret);
    }
  });
});

describe('SIPGES_DATA_KEY_PREVIOUS configuration', () => {
  const load = (env: Record<string, string>) => loadConfig({ ...TEST_ENV, ...env });

  it('has no previous key unless SIPGES_DATA_KEY_PREVIOUS is set', () => {
    expect(load({}).dataKeyPrevious).toBeUndefined();
    const previous = Buffer.alloc(32, 7).toString('base64');
    expect(load({ SIPGES_DATA_KEY_PREVIOUS: previous }).dataKeyPrevious).toEqual(
      Buffer.alloc(32, 7),
    );
  });

  it.each(['', 'not-base64!', Buffer.alloc(16).toString('base64')])(
    'rejects SIPGES_DATA_KEY_PREVIOUS %j',
    (value) => {
      expect(() => load({ SIPGES_DATA_KEY_PREVIOUS: value })).toThrow(
        'SIPGES_DATA_KEY_PREVIOUS must decode to 32 bytes',
      );
    },
  );
});

describe('staged rotation in the API (SIPGES_DATA_KEY_PREVIOUS)', () => {
  it('signs in with MFA sealed under the previous key, before and after the rotation', async () => {
    const t = await createTestApp({
      SIPGES_DATA_KEY: NEW_KEY.toString('base64'),
      SIPGES_DATA_KEY_PREVIOUS: TEST_DATA_KEY,
    });
    const old = Buffer.from(TEST_DATA_KEY, 'base64');
    await t.sql.query(
      "UPDATE users SET totp_enabled = true, totp_secret_sealed = $1 WHERE username = 'admin'",
      [createSecretCipher(old).seal(TOTP.ana)],
    );
    const code = () => totp.codeAt(TOTP.ana, t.clock.now());

    expect((await t.login('admin', 'admin-password-123', code())).res.status).toBe(200);

    const report = await rotateDataKey(t.sql, { oldKey: old, newKey: NEW_KEY, mode: 'apply' });
    expect(report.ok).toBe(true);
    t.clock.advance(60);
    expect((await t.login('admin', 'admin-password-123', code())).res.status).toBe(200);
  });
});

describe('rotate:data-key CLI', () => {
  it('accepts the `--` that pnpm forwards before the flags', () => {
    expect(parseCliArgs(['--', '--apply']).mode).toBe('apply');
    expect(parseCliArgs(['--']).mode).toBe('dry-run');
    expect(parseCliArgs(['--report', 'r.json']).report).toBe('r.json');
  });

  it('is a dry-run by default, writes with --apply and needs the old key', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sipges-rotate-'));
    try {
      const pgliteDir = join(dir, 'pglite');
      const db = new PGlite(pgliteDir);
      await seed(OLD_KEY, db);
      const before = await fingerprint(pgliteClient(db));
      await db.close();
      const env = {
        SIPGES_PGLITE_DIR: pgliteDir,
        SIPGES_DATA_KEY: NEW_KEY.toString('base64'),
        SIPGES_DATA_KEY_PREVIOUS: OLD_KEY.toString('base64'),
      };
      const report = join(dir, 'report.json');

      expect(
        await main([], { SIPGES_PGLITE_DIR: pgliteDir, SIPGES_DATA_KEY: env.SIPGES_DATA_KEY }),
      ).toBe(2);
      expect(await main(['--report', report], env)).toBe(0);
      expect(JSON.parse(await readFile(report, 'utf8'))).toMatchObject({
        mode: 'dry-run',
        ok: true,
      });
      const reopened = new PGlite(pgliteDir);
      expect(await fingerprint(pgliteClient(reopened))).toBe(before);
      await reopened.close();

      expect(await main(['--apply'], env)).toBe(0);
      const rotated = new PGlite(pgliteDir);
      const fresh = createSecretCipher(NEW_KEY);
      expect((await sealedValues(pgliteClient(rotated))).map((v) => fresh.open(v))).toHaveLength(4);
      await rotated.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
