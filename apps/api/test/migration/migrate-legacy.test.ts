import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createSecretCipher } from '../../src/contexts/identity/infrastructure/secret-cipher.ts';
import { moduleForSlug } from '../../src/contexts/records/application/index.ts';
import { loadMigrations, migrate } from '../../src/platform/database/migrator.ts';
import { pgliteClient } from '../../src/platform/database/pglite.ts';
import type { SqlClient } from '../../src/platform/database/sql-client.ts';
import {
  type MigrationMode,
  type MigrationReport,
  reportJson,
  runMigration,
  summarize,
} from '../../src/tools/migrate-legacy/application/migrate.ts';
import type { TargetStore } from '../../src/tools/migrate-legacy/application/ports.ts';
import { main, parseCliArgs } from '../../src/tools/migrate-legacy/cli.ts';
import { emptyCounts, totalRows } from '../../src/tools/migrate-legacy/domain/legacy.ts';
import { createSqlTargetStore } from '../../src/tools/migrate-legacy/infrastructure/sql-target-store.ts';
import {
  createSqliteLegacySource,
  legacyLayout,
} from '../../src/tools/migrate-legacy/infrastructure/sqlite-legacy-source.ts';
import {
  buildLegacyFixture,
  scopeDirectory,
  type LegacyFixture,
} from '../support/legacy-fixture.ts';
import { TEST_DATA_KEY, memoryStorage } from '../support/test-app.ts';
import { trackTestDatabase } from '../support/test-database.ts';

const cipher = () => createSecretCipher(Buffer.from(TEST_DATA_KEY, 'base64'));

const codesOf = (report: MigrationReport) =>
  [...report.problems, ...report.tenants.flatMap((t) => t.problems)].map((p) => p.code);

describe('legacy SQLite → PostgreSQL migration', () => {
  let fixture: LegacyFixture;

  beforeAll(async () => {
    fixture = await buildLegacyFixture();
  });
  afterAll(async () => {
    await fixture.cleanup();
  });

  const target = async () => {
    const db = trackTestDatabase(new PGlite());
    const sql = pgliteClient(db);
    await migrate(sql, await loadMigrations());
    return sql;
  };

  const run = async (
    sql: SqlClient,
    mode: MigrationMode,
    options: { allowNonEmptyTarget?: boolean; storage?: ReturnType<typeof memoryStorage> } = {},
  ) => {
    const store = options.storage ?? memoryStorage();
    const source = createSqliteLegacySource(legacyLayout(fixture.root));
    try {
      const report = await runMigration(
        {
          source,
          target: createSqlTargetStore(sql, cipher()),
          storage: store.storage,
          moduleForSlug,
          now: () => new Date('2026-10-13T00:00:00Z'),
        },
        { mode, allowNonEmptyTarget: options.allowNonEmptyTarget ?? false },
      );
      return { report, store };
    } finally {
      source.close();
    }
  };

  it('reports every module in dry-run and writes nothing', async () => {
    const sql = await target();
    const { report, store } = await run(sql, 'dry-run');

    expect(report.applied).toBe(false);
    expect(report.identity).toMatchObject({
      users: { source: 3, mapped: 2, written: 0 },
      tenants: { source: 2, mapped: 2, written: 0 },
      grants: { source: 4, mapped: 3, written: 0 },
      sessionsSkipped: 1,
    });
    const main = report.tenants.find((t) => t.tenantId === fixture.defaultTenant);
    expect(main?.source).toMatchObject({ module_records: 3, attachments: 2, audit: 1 });
    expect(main?.mapped).toMatchObject({
      module_records: 2,
      audit: 1,
      irsa_configs: 1,
      irsa_snapshots: 1,
      attachments: 1,
      document_review: 1,
      digital_alert_reviews: 1,
      preventive_actions: 1,
      preventive_action_log: 1,
    });
    expect(codesOf(report)).toEqual(
      expect.arrayContaining([
        'user_role_invalid',
        'grant_user_unknown',
        'record_payload_invalid',
        'attachment_object_missing',
        'sessions_not_migrated',
      ]),
    );
    // Nothing reached the database or the object store.
    for (const tenant of report.tenants) expect(tenant.target).toMatchObject({ module_records: 0 });
    const [users] = await sql.query<{ n: string }>('SELECT count(*) AS n FROM users');
    expect(Number(users?.n)).toBe(0);
    expect(store.objects.size).toBe(0);
  });

  it('applies the migration, then verifies counts, checksums and attachment bytes', async () => {
    const sql = await target();
    const storage = memoryStorage();
    const { report } = await run(sql, 'apply', { storage });

    expect(report.applied).toBe(true);
    expect(report.identity.users.written).toBe(2);
    expect(report.identity.tenants.written).toBe(2);
    expect(report.identity.grants.written).toBe(3);
    const main = report.tenants.find((t) => t.tenantId === fixture.defaultTenant);
    expect(main?.written).toEqual(main?.mapped);
    expect(main?.target).toEqual(main?.mapped);
    expect(main?.objects.copied).toBe(1);
    expect(storage.objects.size).toBe(2);

    // Legacy password hashes are kept verbatim; the identity context rehashes them on login.
    const [user] = await sql.query<{ password_hash: string; totp_secret_sealed: string | null }>(
      'SELECT password_hash, totp_secret_sealed FROM users WHERE username = $1',
      [fixture.analystUser],
    );
    expect(user?.password_hash.startsWith('pbkdf2_sha256$310000$')).toBe(true);
    expect(user?.totp_secret_sealed?.startsWith('v1.')).toBe(true);
    expect(user?.totp_secret_sealed).not.toContain(fixture.totpSecret);
    expect(cipher().open(user?.totp_secret_sealed ?? '')).toBe(fixture.totpSecret);

    const verified = (await run(sql, 'verify', { storage })).report;
    expect(verified.applied).toBe(false);
    // Verify re-reads the source, so the rows the source itself cannot migrate are reported
    // again; what must not appear is any mismatch between source and target.
    expect(codesOf(verified).filter((code) => code.startsWith('verify_'))).toEqual([]);
    for (const tenant of verified.tenants)
      expect(tenant.checksums.target).toEqual(tenant.checksums.source);
    expect(
      verified.tenants.find((t) => t.tenantId === fixture.defaultTenant)?.objects.verified,
    ).toBe(1);
  });

  it('refuses to apply twice and stays idempotent when explicitly allowed', async () => {
    const sql = await target();
    const storage = memoryStorage();
    await run(sql, 'apply', { storage });

    const refused = (await run(sql, 'apply', { storage })).report;
    expect(refused.applied).toBe(false);
    expect(refused.ok).toBe(false);
    expect(refused.problems.map((p) => p.code)).toContain('target_not_empty');
    expect(refused.identity.users.written).toBe(0);

    const forced = (await run(sql, 'apply', { storage, allowNonEmptyTarget: true })).report;
    expect(forced.applied).toBe(true);
    expect(forced.ok).toBe(false);
    // Tenants that already hold rows are skipped as a whole: audit and irsa_snapshots have
    // generated keys and would otherwise be duplicated.
    for (const tenant of forced.tenants) {
      expect(tenant.problems.map((p) => p.code)).toContain('tenant_not_empty');
      expect(totalRows(tenant.written)).toBe(0);
      expect(tenant.target).toEqual(tenant.mapped);
    }
    // Existing accounts, tenants and grants are reported, never silently counted as migrated.
    expect(forced.identity.users.written).toBe(0);
    const present = forced.problems.filter((p) => p.code === 'row_already_present');
    expect(present.filter((p) => p.table === 'users').map((p) => p.id)).toEqual([
      fixture.adminUser,
      fixture.analystUser,
    ]);
    expect(present.filter((p) => p.table === 'tenants')).toHaveLength(2);
    expect(present.filter((p) => p.table === 'grants')).toHaveLength(3);
    expect(present.every((p) => p.severity === 'error')).toBe(true);
  });

  it('reports a bootstrapped account instead of keeping it silently, and verify flags it', async () => {
    const sql = await target();
    const storage = memoryStorage();
    // The API bootstrapped an account with the legacy admin's name before the migration.
    await sql.query(
      `INSERT INTO users (username, full_name, password_hash, role, totp_enabled)
       VALUES ($1, 'Bootstrap', '$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA', 'consulta', false)`,
      [fixture.adminUser],
    );
    const applied = (await run(sql, 'apply', { storage, allowNonEmptyTarget: true })).report;
    expect(applied.applied).toBe(true);
    expect(applied.ok).toBe(false);
    expect(applied.identity.users.written).toBe(1);
    expect(applied.problems).toContainEqual(
      expect.objectContaining({
        code: 'row_already_present',
        severity: 'error',
        table: 'users',
        id: fixture.adminUser,
      }),
    );

    const verified = (await run(sql, 'verify', { storage })).report;
    expect(verified.ok).toBe(false);
    expect(verified.problems).toContainEqual(
      expect.objectContaining({ code: 'verify_user_mismatch', id: fixture.adminUser }),
    );
    expect(
      verified.problems.filter((p) => p.code.startsWith('verify_') && p.id !== fixture.adminUser),
    ).toEqual([]);
    // Neither hash appears in the output.
    expect(reportJson(verified)).not.toContain('$argon2id$');
    expect(reportJson(verified)).not.toContain('pbkdf2_sha256$');
  });

  it('verify checksums every migrated tenant table, not only records', async () => {
    const sql = await target();
    const storage = memoryStorage();
    await run(sql, 'apply', { storage });
    const tenant = fixture.defaultTenant;
    // PGlite runs as a superuser, so these edits bypass RLS like a manual change would.
    const edits: Record<string, string> = {
      irsa_configs: `UPDATE irsa_configs SET config = '{"version":"otra"}' WHERE tenant_id = $1`,
      digital_alert_reviews: `UPDATE digital_alert_reviews SET reviewer_note = 'x' WHERE tenant_id = $1`,
      preventive_actions: `UPDATE preventive_actions SET progress = 41 WHERE tenant_id = $1`,
      preventive_action_log: `UPDATE preventive_action_log SET note = 'x' WHERE tenant_id = $1`,
      audit: `UPDATE audit SET detail = 'x' WHERE tenant_id = $1`,
      irsa_snapshots: `UPDATE irsa_snapshots SET note = 'x' WHERE tenant_id = $1`,
      document_review: `UPDATE document_review SET status = 'descartado' WHERE tenant_id = $1`,
      attachments: `UPDATE attachments SET notes = 'x' WHERE tenant_id = $1`,
      module_records: `UPDATE module_records SET updated_at = now() WHERE tenant_id = $1`,
    };
    for (const statement of Object.values(edits)) await sql.query(statement, [tenant]);

    const verified = (await run(sql, 'verify', { storage })).report;
    const mismatched = verified.tenants
      .find((t) => t.tenantId === tenant)
      ?.problems.filter((p) => p.code === 'verify_checksum_mismatch')
      .map((p) => p.table)
      .sort();
    expect(mismatched).toEqual(Object.keys(edits).sort());
    // The untouched tenant still verifies cleanly.
    const other = verified.tenants.find((t) => t.tenantId === fixture.otherTenant);
    expect(other?.problems.filter((p) => p.code.startsWith('verify_'))).toEqual([]);
  });

  it('reports a failing tenant, keeps applying the others and resumes without duplicates', async () => {
    const sql = await target();
    const storage = memoryStorage();
    const store = createSqlTargetStore(sql, cipher());
    const failing: TargetStore = {
      ...store,
      writeTenant: (tenantId, batch) =>
        tenantId === fixture.otherTenant
          ? Promise.reject(new Error('MARCADOR-ERROR-DRIVER'))
          : store.writeTenant(tenantId, batch),
    };
    const source = createSqliteLegacySource(legacyLayout(fixture.root));
    let first: MigrationReport;
    try {
      first = await runMigration(
        {
          source,
          target: failing,
          storage: storage.storage,
          moduleForSlug,
          now: () => new Date('2026-10-13T00:00:00Z'),
        },
        { mode: 'apply' },
      );
    } finally {
      source.close();
    }
    expect(first.ok).toBe(false);
    const failed = first.tenants.find((t) => t.tenantId === fixture.otherTenant);
    expect(failed?.problems).toContainEqual({
      code: 'tenant_write_failed',
      severity: 'error',
      tenantId: fixture.otherTenant,
    });
    expect(totalRows(failed?.target ?? emptyCounts())).toBe(0);
    const main = first.tenants.find((t) => t.tenantId === fixture.defaultTenant);
    expect(main?.target).toEqual(main?.mapped);
    expect(reportJson(first)).not.toContain('MARCADOR-ERROR-DRIVER');

    // Resume: the finished tenant is skipped (no duplicated audit/snapshots), the failed one
    // is written now.
    const resumed = (await run(sql, 'apply', { storage, allowNonEmptyTarget: true })).report;
    const again = resumed.tenants.find((t) => t.tenantId === fixture.defaultTenant);
    expect(again?.problems.map((p) => p.code)).toContain('tenant_not_empty');
    expect(again?.target).toEqual(again?.mapped);
    const other = resumed.tenants.find((t) => t.tenantId === fixture.otherTenant);
    expect(other?.written).toEqual(other?.mapped);

    const verified = (await run(sql, 'verify', { storage })).report;
    expect(codesOf(verified).filter((code) => code.startsWith('verify_'))).toEqual([]);
  });

  it('migrates the default IRSA configuration for a tenant without its own file', async () => {
    const own = await buildLegacyFixture();
    try {
      await rm(join(own.root, 'data', 'tenants', `${scopeDirectory(own.otherTenant)}_settings`), {
        recursive: true,
      });
      const sql = await target();
      const storage = memoryStorage();
      const layout = legacyLayout(own.root);
      const once = async (mode: MigrationMode) => {
        const source = createSqliteLegacySource(layout);
        try {
          return await runMigration(
            {
              source,
              target: createSqlTargetStore(sql, cipher()),
              storage: storage.storage,
              moduleForSlug,
              now: () => new Date('2026-10-13T00:00:00Z'),
            },
            { mode },
          );
        } finally {
          source.close();
        }
      };
      const applied = await once('apply');
      const other = applied.tenants.find((t) => t.tenantId === own.otherTenant);
      expect(other?.mapped.irsa_configs).toBe(1);
      expect(other?.problems).toContainEqual(
        expect.objectContaining({ code: 'irsa_config_inherited', severity: 'info' }),
      );
      const [row] = await sql.query<{ version: string }>(
        `SELECT config->>'version' AS version FROM irsa_configs WHERE tenant_id = $1`,
        [own.otherTenant],
      );
      expect(row?.version).toBe('0.4-sintetica');
      const verified = await once('verify');
      expect(codesOf(verified).filter((code) => code.startsWith('verify_'))).toEqual([]);
    } finally {
      await own.cleanup();
    }
  });

  it('never leaks record contents, password hashes or TOTP secrets into its output', async () => {
    const sql = await target();
    const { report } = await run(sql, 'dry-run');
    const output = `${summarize(report)}\n${reportJson(report)}`;

    for (const secret of fixture.secrets) expect(output).not.toContain(secret);
    expect(output).not.toContain('pbkdf2_sha256$');
    expect(output).toContain('module_records');
    expect(summarize(report)).toContain('sessions skipped 1');
  });

  it('reads uploads only as regular files directly inside the scope folder', async () => {
    const own = await buildLegacyFixture();
    try {
      const uploads = join(own.root, 'data', 'uploads');
      const otherFolder = scopeDirectory(own.otherTenant);
      await writeFile(join(uploads, otherFolder, 'ajeno.txt'), 'x');
      await writeFile(join(uploads, 'propio.txt'), 'propio');
      await symlink(join(uploads, otherFolder, 'ajeno.txt'), join(uploads, 'enlace.txt'));
      const source = createSqliteLegacySource(legacyLayout(own.root));
      const reader = await source.openTenant({
        companyId: 'SIPGES',
        projectId: 'PRJ-SECHURA',
        label: '',
      });
      try {
        expect(Buffer.from((await reader.readObject('propio.txt')) ?? []).toString()).toBe(
          'propio',
        );
        // Another tenant's folder sits inside the default upload root.
        expect(await reader.readObject(`${otherFolder}/ajeno.txt`)).toBeNull();
        expect(await reader.readObject(`../uploads/${otherFolder}/ajeno.txt`)).toBeNull();
        // A symlink is never followed.
        expect(await reader.readObject('enlace.txt')).toBeNull();
      } finally {
        await reader.close();
        source.close();
      }
    } finally {
      await own.cleanup();
    }
  });

  it('refuses --dry-run together with --apply', () => {
    expect(() => parseCliArgs(['--dry-run', '--apply', '--legacy-root', '/x'])).toThrow(
      'Choose either --dry-run or --apply',
    );
    expect(() => parseCliArgs(['--dry-run', '--verify'])).toThrow(
      'Choose either --dry-run or --verify',
    );
    expect(parseCliArgs(['--dry-run']).mode).toBe('dry-run');
  });

  it('accepts the -- that pnpm forwards from the runbook command', () => {
    expect(parseCliArgs(['--', '--legacy-root', '/x', '--apply'])).toMatchObject({
      'legacy-root': '/x',
      mode: 'apply',
    });
    expect(() => parseCliArgs(['--', 'posicional'])).toThrow();
  });

  it('does not read a target with pending schema migrations in a dry run', async () => {
    const untouched = new Proxy({} as TargetStore, {
      get: (_target, name) => () => {
        throw new Error(`target read: ${String(name)}`);
      },
    });
    const source = createSqliteLegacySource(legacyLayout(fixture.root));
    try {
      const report = await runMigration(
        {
          source,
          target: untouched,
          storage: memoryStorage().storage,
          moduleForSlug,
          now: () => new Date('2026-10-13T00:00:00Z'),
        },
        { mode: 'dry-run', targetMigrationsPending: 3 },
      );
      expect(report.problems).toContainEqual({
        code: 'target_migrations_pending',
        severity: 'info',
        count: 3,
      });
      expect(report.tenants.every((t) => totalRows(t.target) === 0)).toBe(true);
      expect(summarize(report)).toContain('target not read, pending schema migrations: 3');
    } finally {
      source.close();
    }
  });

  it('leaves the target schema alone in a dry run of the CLI', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sipges-dry-run-'));
    vi.stubEnv('SIPGES_DATABASE_URL', '');
    vi.stubEnv('SIPGES_PGLITE_DIR', dir);
    vi.stubEnv('SIPGES_DATA_KEY', TEST_DATA_KEY);
    vi.stubEnv('SIPGES_UPLOAD_DIR', join(dir, 'objects'));
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    try {
      await main(['--legacy-root', fixture.root]);
      expect(info.mock.calls.flat().join('\n')).toContain('target not read,');
      const db = trackTestDatabase(new PGlite(dir));
      const { rows } = await db.query<{ name: string | null }>(
        "SELECT to_regclass('schema_migrations')::text AS name",
      );
      expect(rows).toEqual([{ name: null }]);
    } finally {
      info.mockRestore();
      vi.unstubAllEnvs();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reads text in the encoding of the legacy file and keeps generated columns', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sipges-utf16-'));
    try {
      const db = new DatabaseSync(join(dir, 'auth.db'));
      db.exec(`
        PRAGMA encoding = 'UTF-16le';
        CREATE TABLE auth_users (username, doble GENERATED ALWAYS AS (username || username) VIRTUAL);
        CREATE TABLE tenant_projects (company_id, project_id, label);
        INSERT INTO auth_users VALUES ('ñandú😀');`);
      db.close();
      const source = createSqliteLegacySource({
        authDb: join(dir, 'auth.db'),
        defaultDb: join(dir, 'no.db'),
        tenantDir: dir,
        uploadDir: dir,
        configDir: dir,
      });
      try {
        expect(await source.users()).toEqual([{ username: 'ñandú😀', doble: 'ñandú😀ñandú😀' }]);
      } finally {
        source.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reports a row refused for NUL by position, never by the value', async () => {
    const own = await buildLegacyFixture();
    try {
      const auth = new DatabaseSync(join(own.root, 'data/auth_global.db'));
      auth.exec(`
        INSERT INTO auth_users (username, full_name, password_hash, role, active, created_at, totp_enabled)
          VALUES (CAST(x'6d6172636100636f6e74656e69646f' AS TEXT), 'n', 'h', 'admin', 1, '2026-01-01', 0);
        INSERT INTO access_grants VALUES (CAST(x'6d6172636100636f6e74656e69646f' AS TEXT), 'SIPGES', 'PRJ-SECHURA');`);
      auth.close();
      const db = new DatabaseSync(join(own.root, 'data/sipges.db'));
      db.exec(`
        DROP TABLE records;
        CREATE TABLE records (module, record_id, payload, created_at, updated_at);
        INSERT INTO records VALUES ('Eventos', CAST(x'6d6172636100636f6e74656e69646f' AS TEXT), '{}', 'x', 'x');
        INSERT INTO records VALUES ('Eventos', x'6d6172636100636f6e74656e69646f', '{}', 'x', 'x');`);
      db.close();
      const source = createSqliteLegacySource(legacyLayout(own.root));
      try {
        const report = await runMigration(
          {
            source,
            target: createSqlTargetStore(await target(), cipher()),
            storage: memoryStorage().storage,
            moduleForSlug,
            now: () => new Date('2026-10-13T00:00:00Z'),
          },
          { mode: 'dry-run' },
        );
        const json = reportJson(report);
        expect(json).not.toContain('contenido');
        expect(json).not.toContain('marca');
        expect(json).not.toContain('109,97,114');
        const refused = report.tenants.flatMap((t) => t.problems);
        expect(refused.map((p) => p.id)).toEqual(expect.arrayContaining(['#0', '#1']));
      } finally {
        source.close();
      }
    } finally {
      await own.cleanup();
    }
  });

  it('reads text with NUL whole, so it is refused and never cut short', async () => {
    const own = await buildLegacyFixture();
    try {
      const db = new DatabaseSync(join(own.root, 'data/sipges.db'));
      db.exec(`
        DROP TABLE records;
        CREATE TABLE records (module, record_id, payload, created_at, updated_at);
        INSERT INTO records VALUES ('Eventos', CAST(x'4556002d31' AS TEXT), '{}', '2026-01-01', '2026-01-01');
        INSERT INTO records VALUES ('Eventos', 'EV-2', '{}', 1790000000, 1790000000.5);
        INSERT INTO records VALUES ('Eventos', 'EV-3', x'7b7d', '2026-01-01', '2026-01-01');
        INSERT INTO records VALUES ('Eventos', 'EV-4', CAST(x'7b7dff' AS TEXT), '2026-01-01', NULL);`);
      db.close();
      const source = createSqliteLegacySource(legacyLayout(own.root));
      const reader = await source.openTenant({
        companyId: 'SIPGES',
        projectId: 'PRJ-SECHURA',
        label: '',
      });
      try {
        const rows = await reader.records();
        const byId = new Map(rows.map((row) => [row['record_id'], row]));
        expect(byId.has('EV\u0000-1')).toBe(true);
        expect(byId.get('EV-2')?.['created_at']).toBe(1790000000);
        expect(byId.get('EV-2')?.['updated_at']).toBe(1790000000.5);
        expect(byId.get('EV-3')?.['payload']).toEqual(new Uint8Array([0x7b, 0x7d]));
        expect(byId.get('EV-4')?.['payload']).toBe('{}\ufffd');
        expect(byId.get('EV-4')?.['updated_at']).toBeNull();
      } finally {
        await reader.close();
        source.close();
      }
    } finally {
      await own.cleanup();
    }
  });
});
