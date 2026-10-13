import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
import { createSqlTargetStore } from '../../src/tools/migrate-legacy/infrastructure/sql-target-store.ts';
import {
  createSqliteLegacySource,
  legacyLayout,
} from '../../src/tools/migrate-legacy/infrastructure/sqlite-legacy-source.ts';
import { buildLegacyFixture, type LegacyFixture } from '../support/legacy-fixture.ts';
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
    expect(
      verified.tenants.every((t) => t.checksums.targetRecords === t.checksums.sourceRecords),
    ).toBe(true);
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
    const main = forced.tenants.find((t) => t.tenantId === fixture.defaultTenant);
    // Keyed tables ignore rows that already exist; only the append-only audit grows.
    expect(main?.written.module_records).toBe(0);
    expect(main?.written.attachments).toBe(0);
    expect(main?.target.module_records).toBe(main?.mapped.module_records);
    expect(forced.identity.users.written).toBe(0);
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
});
