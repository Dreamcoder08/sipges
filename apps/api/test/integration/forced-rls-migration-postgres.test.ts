import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadMigrations, migrate } from '../../src/platform/database/migrator.ts';
import { postgresClient } from '../../src/platform/database/postgres.ts';

const adminUrl = process.env.SIPGES_TEST_DATABASE_URL;
const AT = '2026-10-01T08:00:00Z';

/**
 * Production's login after the role cutover: a NOSUPERUSER, NOBYPASSRLS owner, with rows already
 * in place. As the old BYPASSRLS login a data migration reached every row; as this one it reaches
 * none unless it lifts FORCE, and nothing reports that (docs/deployment/production-role-cutover.md).
 */
describe.skipIf(!adminUrl)('a data migration as a non-BYPASSRLS owner', () => {
  const suffix = randomBytes(6).toString('hex');
  const name = `sipges_test_${suffix}`;
  const owner = `sipges_test_${suffix}_owner`;
  let admin: postgres.Sql;
  let scratch: postgres.Sql;
  let pool: ReturnType<typeof postgresClient>;

  const marked = async () => {
    const rows = await scratch<{ n: number }[]>`
      SELECT count(*)::int AS n FROM module_records WHERE payload ? 'migrated'`;
    return rows[0]?.n;
  };
  const forced = async () => {
    const rows = await scratch<{ relforcerowsecurity: boolean }[]>`
      SELECT relforcerowsecurity FROM pg_class WHERE oid = 'module_records'::regclass`;
    return rows[0]?.relforcerowsecurity;
  };

  beforeAll(async () => {
    admin = postgres(adminUrl ?? '', { max: 1, onnotice: () => undefined });
    await admin.unsafe(`CREATE ROLE ${owner} LOGIN PASSWORD '${suffix}'
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`);
    for (const role of ['mascli_tenant', 'sipges_tenant']) {
      await admin.unsafe(`DO $$ BEGIN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${role}') THEN
          CREATE ROLE ${role} NOLOGIN NOINHERIT;
        END IF; END $$`);
      await admin.unsafe(`GRANT ${role} TO ${owner} WITH ADMIN OPTION`);
    }
    await admin.unsafe(`CREATE DATABASE ${name} OWNER ${owner}`);
    const server = new URL(adminUrl ?? '');
    server.pathname = `/${name}`;
    scratch = postgres(server.toString(), { max: 1, onnotice: () => undefined });
    server.username = owner;
    server.password = suffix;
    pool = postgresClient(server.toString());
    await migrate(pool.client, await loadMigrations());
    await scratch.unsafe(`
      INSERT INTO tenants (company_id, project_id, label) VALUES ('SIPGES', 'PRJ-T1', 'a'), ('SIPGES', 'PRJ-T2', 'b');
      INSERT INTO module_records (tenant_id, module, id, payload, marking, created_at, updated_at)
      VALUES ('SIPGES/PRJ-T1', 'Fuentes', 'R1', '{}', 'interno', '${AT}', '${AT}'),
             ('SIPGES/PRJ-T2', 'Fuentes', 'R2', '{}', 'interno', '${AT}', '${AT}')`);
  });

  afterAll(async () => {
    await pool?.close();
    await scratch?.end();
    await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.unsafe(`DROP ROLE IF EXISTS ${owner}`);
    await admin.end();
  });

  const SET = `UPDATE module_records SET payload = payload || '{"migrated": true}'`;

  it('rewrites nothing while FORCE stays, and is still recorded as applied', async () => {
    const version = '9000_rewrite_under_force';
    const applied = await migrate(pool.client, [
      ...(await loadMigrations()),
      { version, sql: `${SET};` },
    ]);
    expect(applied).toEqual([version]);
    expect(await marked()).toBe(0);
  });

  it('rewrites every project once it lifts FORCE, and restores it', async () => {
    const version = '9001_rewrite_with_force_lifted';
    await migrate(pool.client, [
      ...(await loadMigrations()),
      { version: '9000_rewrite_under_force', sql: '' },
      {
        version,
        sql: `ALTER TABLE module_records NO FORCE ROW LEVEL SECURITY;
          ${SET};
          ALTER TABLE module_records FORCE ROW LEVEL SECURITY;`,
      },
    ]);
    expect(await marked()).toBe(2);
    expect(await forced()).toBe(true);
  });
});
