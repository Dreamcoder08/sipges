/**
 * The legacy migration against a real PostgreSQL server (RLS, roles and driver typing that
 * single-connection PGlite cannot exercise). Opt-in:
 *   MASCLI_TEST_DATABASE_URL=postgres://postgres:secret@127.0.0.1:5432/postgres pnpm test
 */
import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSecretCipher } from '../../src/contexts/identity/infrastructure/secret-cipher.ts';
import { moduleForSlug } from '../../src/contexts/records/application/index.ts';
import { loadMigrations, migrate } from '../../src/platform/database/migrator.ts';
import { postgresClient } from '../../src/platform/database/postgres.ts';
import { withTenant } from '../../src/platform/database/tenant-transaction.ts';
import { runMigration } from '../../src/tools/migrate-legacy/application/migrate.ts';
import { createSqlTargetStore } from '../../src/tools/migrate-legacy/infrastructure/sql-target-store.ts';
import {
  createSqliteLegacySource,
  legacyLayout,
} from '../../src/tools/migrate-legacy/infrastructure/sqlite-legacy-source.ts';
import { buildLegacyFixture, type LegacyFixture } from '../support/legacy-fixture.ts';
import { TEST_DATA_KEY, memoryStorage } from '../support/test-app.ts';

const adminUrl = process.env.MASCLI_TEST_DATABASE_URL;

describe.skipIf(!adminUrl)('legacy migration on real PostgreSQL', () => {
  const name = `mascli_migration_test_${randomBytes(6).toString('hex')}`;
  let admin: postgres.Sql;
  let pool: ReturnType<typeof postgresClient>;
  let fixture: LegacyFixture;

  beforeAll(async () => {
    fixture = await buildLegacyFixture();
    admin = postgres(adminUrl ?? '', { max: 1 });
    await admin.unsafe(`CREATE DATABASE ${name}`);
    const parsed = new URL(adminUrl ?? '');
    parsed.pathname = `/${name}`;
    pool = postgresClient(parsed.toString());
    await migrate(pool.client, await loadMigrations());
  });

  afterAll(async () => {
    await pool?.close();
    if (admin) {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await admin.end();
    }
    await fixture?.cleanup();
  });

  it('applies and verifies every tenant through withTenant transactions', async () => {
    const storage = memoryStorage();
    const run = async (mode: 'apply' | 'verify') => {
      const source = createSqliteLegacySource(legacyLayout(fixture.root));
      try {
        return await runMigration(
          {
            source,
            target: createSqlTargetStore(
              pool.client,
              createSecretCipher(Buffer.from(TEST_DATA_KEY, 'base64')),
            ),
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

    const applied = await run('apply');
    expect(applied.applied).toBe(true);
    expect(applied.identity.users.written).toBe(2);
    for (const tenant of applied.tenants) expect(tenant.written).toEqual(tenant.mapped);

    const verified = await run('verify');
    expect(verified.tenants.flatMap((t) => t.problems).map((p) => p.code)).not.toContain(
      'verify_count_mismatch',
    );
    expect(
      verified.tenants.every((t) => t.checksums.targetRecords === t.checksums.sourceRecords),
    ).toBe(true);

    // Rows really are tenant-scoped: inside one tenant's transaction the other is invisible.
    const visible = await withTenant(pool.client, 'MASCLI/PRJ-SECHURA', async (tx) =>
      tx.query<{ tenant_id: string }>('SELECT DISTINCT tenant_id FROM module_records'),
    );
    expect(visible.map((r) => r.tenant_id)).toEqual(['MASCLI/PRJ-SECHURA']);

    // Regression: postgres.js must not JSON-encode JSON text parameters a second time.
    const [typed] = await withTenant(pool.client, 'MASCLI/PRJ-SECHURA', async (tx) =>
      tx.query<{ t: string }>('SELECT jsonb_typeof(payload) AS t FROM module_records LIMIT 1'),
    );
    expect(typed?.t).toBe('object');
  });
});
