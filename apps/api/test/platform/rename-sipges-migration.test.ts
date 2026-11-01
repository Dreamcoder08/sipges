import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';
import { pgliteClient } from '../../src/platform/database/pglite.ts';
import { loadMigrations, migrate } from '../../src/platform/database/migrator.ts';
import { withTenant } from '../../src/platform/database/tenant-transaction.ts';
import { trackTestDatabase } from '../support/test-database.ts';

const VERSION = '0030_rename_to_sipges';
const OLD = 'MASCLI';
const NEW = 'SIPGES';

type Shape = { relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean };

/** A database migrated up to the migration before the rename, holding two MASCLI tenants. */
const legacyDatabase = async () => {
  const db = trackTestDatabase(new PGlite());
  const all = await loadMigrations();
  const index = all.findIndex((m) => m.version === VERSION);
  expect(index).toBeGreaterThan(0);
  await migrate(pgliteClient(db), all.slice(0, index));

  await db.exec(`
    INSERT INTO tenants (company_id, project_id, label) VALUES
      ('${OLD}', 'PRJ-X', 'X'), ('${OLD}', 'PRJ-Y', 'Y'), ('OTRA', 'PRJ-Z', 'Z');
    INSERT INTO users (username, full_name, password_hash, role) VALUES ('ana', 'Ana', 'h', 'admin');
    INSERT INTO grants (username, tenant_id) VALUES
      ('ana', '${OLD}/PRJ-X'), ('ana', '${OLD}/PRJ-Y'), ('ana', 'OTRA/PRJ-Z');
  `);
  const record = (tenant: string, id: string, payload: object) =>
    db.query(
      `INSERT INTO module_records (tenant_id, module, id, payload, created_at, updated_at, marking)
       VALUES ($1, $2, $3, $4::jsonb, now(), now(), 'interno')`,
      [tenant, id.startsWith('A-') ? 'Alertas' : 'Demandas', id, JSON.stringify(payload)],
    );
  await record(`${OLD}/PRJ-X`, 'D-X', { Tema: 'Agua' });
  await record(`${OLD}/PRJ-X`, 'A-X', { Origen: `${OLD} 4.0`, Titulo: 'Sugerida' });
  await record(`${OLD}/PRJ-X`, 'A-MANUAL', { Origen: 'Manual' });
  await record(`${OLD}/PRJ-Y`, 'D-Y', { Tema: 'Tierra' });
  await record('OTRA/PRJ-Z', 'D-Z', { Tema: 'Otra' });
  await db.exec(`
    INSERT INTO audit (tenant_id, ts, module, action, id) OVERRIDING SYSTEM VALUE VALUES
      ('${OLD}/PRJ-X', now(), '${OLD} 4.0', 'settings.update', 9001),
      ('${OLD}/PRJ-X', now(), 'Demandas', 'create', 9002),
      ('OTRA/PRJ-Z', now(), '${OLD} 4.0', 'settings.update', 9003);
    INSERT INTO irsa_snapshots (tenant_id, ts, irsa, level, scores)
      VALUES ('${OLD}/PRJ-Y', now(), 40, 'Amarillo', '{}');
    INSERT INTO project_settings (tenant_id, settings, updated_by, updated_at)
      VALUES ('${OLD}/PRJ-X', '{}', 'ana', now());
    INSERT INTO attachments (tenant_id, id, storage_key, original_name, content_type, size_bytes,
      sha256, linked_module, record_module, linked_record_id, document_type, author, verification,
      notes, project_id, project_name, created_at)
    VALUES ('${OLD}/PRJ-X', 'ATT-1', 'k', 'f.pdf', 'application/pdf', 1, repeat('a', 64), 'Demandas',
      'Demandas', 'D-X', 'x', 'ana', 'x', '', 'PRJ-X', 'X', now());
    INSERT INTO record_links (tenant_id, link_type, source_module, source_id, target_module,
      target_id, created_by, created_at)
    VALUES ('${OLD}/PRJ-X', 'related', 'Demandas', 'D-X', 'Alertas', 'A-X', 'ana', now());
  `);
  return { db, all, index };
};

const shapes = async (db: PGlite) =>
  (
    await db.query<Shape>(
      `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
       WHERE relkind = 'r' AND relnamespace = 'public'::regnamespace ORDER BY relname`,
    )
  ).rows;

const foreignKeys = async (db: PGlite) =>
  (
    await db.query<{ conname: string; def: string; convalidated: boolean }>(
      `SELECT conname, pg_get_constraintdef(oid) AS def, convalidated FROM pg_constraint
       WHERE contype = 'f' AND connamespace = 'public'::regnamespace ORDER BY conname`,
    )
  ).rows;

const expectRenamed = async (db: PGlite) => {
  // Every table holding a tenant id, enumerated from the catalog so none is missed.
  const tables = (
    await db.query<{ table_name: string }>(
      `SELECT c.table_name FROM information_schema.columns c
       JOIN information_schema.tables t USING (table_schema, table_name)
       WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE' AND c.column_name = 'tenant_id'`,
    )
  ).rows.map((r) => r.table_name);
  expect(tables.length).toBeGreaterThan(20);
  for (const table of tables) {
    const left = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM "${table}" WHERE tenant_id LIKE '${OLD}%'`,
    );
    expect(left.rows[0]?.n, `${table} still holds ${OLD} tenant ids`).toBe(0);
  }

  const tenants = await db.query<{ tenant_id: string }>(
    'SELECT tenant_id FROM tenants ORDER BY tenant_id',
  );
  expect(tenants.rows.map((r) => r.tenant_id)).toEqual([
    'OTRA/PRJ-Z',
    `${NEW}/PRJ-X`,
    `${NEW}/PRJ-Y`,
  ]);
  const companies = await db.query<{ company_id: string }>(
    'SELECT DISTINCT company_id FROM tenants ORDER BY company_id',
  );
  expect(companies.rows.map((r) => r.company_id)).toEqual(['OTRA', NEW]);
  const grants = await db.query<{ tenant_id: string }>(
    'SELECT tenant_id FROM grants ORDER BY tenant_id',
  );
  expect(grants.rows.map((r) => r.tenant_id)).toEqual([
    'OTRA/PRJ-Z',
    `${NEW}/PRJ-X`,
    `${NEW}/PRJ-Y`,
  ]);
  const records = await db.query<{ tenant_id: string; id: string }>(
    'SELECT tenant_id, id FROM module_records ORDER BY tenant_id, id',
  );
  expect(records.rows).toEqual([
    { tenant_id: 'OTRA/PRJ-Z', id: 'D-Z' },
    { tenant_id: `${NEW}/PRJ-X`, id: 'A-MANUAL' },
    { tenant_id: `${NEW}/PRJ-X`, id: 'A-X' },
    { tenant_id: `${NEW}/PRJ-X`, id: 'D-X' },
    { tenant_id: `${NEW}/PRJ-Y`, id: 'D-Y' },
  ]);

  // Stored product names: alert origin (current rows and their history) and audit module.
  const origins = await db.query<{ id: string; origen: string }>(
    "SELECT id, payload->>'Origen' AS origen FROM module_records WHERE module = 'Alertas' ORDER BY id",
  );
  expect(origins.rows).toEqual([
    { id: 'A-MANUAL', origen: 'Manual' },
    { id: 'A-X', origen: NEW },
  ]);
  const history = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM record_versions WHERE payload->>'Origen' = '${OLD} 4.0'`,
  );
  expect(history.rows[0]?.n).toBe(0);
  const modules = await db.query<{ id: number; module: string }>(
    'SELECT id, module FROM audit ORDER BY id',
  );
  expect(modules.rows).toEqual([
    { id: 9001, module: NEW },
    { id: 9002, module: 'Demandas' },
    { id: 9003, module: NEW },
  ]);
  const stale = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM audit WHERE module = '${OLD} 4.0'`,
  );
  expect(stale.rows[0]?.n).toBe(0);

  // The composite foreign keys followed their rows.
  const joined = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM attachments a
     JOIN module_records r ON (r.tenant_id, r.module, r.id) = (a.tenant_id, a.record_module, a.linked_record_id)`,
  );
  expect(joined.rows[0]?.n).toBe(1);
};

const expectRoleAndIsolation = async (db: PGlite) => {
  const roles = await db.query<{ rolname: string }>(
    "SELECT rolname FROM pg_roles WHERE rolname IN ('sipges_tenant', 'mascli_tenant')",
  );
  expect(roles.rows.map((r) => r.rolname)).toContain('sipges_tenant');

  // sipges_tenant carries the grants mascli_tenant had; nothing is left on the old role.
  const privileges = await db.query<{ ok: boolean }>(
    `SELECT has_table_privilege('sipges_tenant', 'module_records', 'SELECT,INSERT,UPDATE,DELETE')
        AND has_table_privilege('sipges_tenant', 'audit', 'SELECT,INSERT')
        AND NOT has_table_privilege('sipges_tenant', 'users', 'SELECT')
        AND has_sequence_privilege('sipges_tenant', 'audit_id_seq', 'USAGE')
        AND has_schema_privilege('sipges_tenant', 'public', 'USAGE')
        -- Column-level grants survive the move (REVOKE ALL on a table drops them).
        AND has_column_privilege('sipges_tenant', 'record_links', 'evidence_source_id', 'UPDATE') AS ok`,
  );
  expect(privileges.rows[0]?.ok).toBe(true);
  if (roles.rows.some((r) => r.rolname === 'mascli_tenant')) {
    const old = await db.query<{ ok: boolean }>(
      `SELECT NOT has_table_privilege('mascli_tenant', 'module_records', 'SELECT') AS ok`,
    );
    expect(old.rows[0]?.ok).toBe(true);
  }

  // The classification helper was renamed in place: policies keep calling it.
  const functions = await db.query<{ proname: string }>(
    "SELECT proname FROM pg_proc WHERE proname IN ('sipges_can_see', 'mascli_can_see')",
  );
  expect(functions.rows.map((r) => r.proname)).toEqual(['sipges_can_see']);

  // Two tenants stay isolated under the new role, and the old scope matches nothing.
  const sql = pgliteClient(db);
  const ids = (tenant: string) =>
    withTenant(sql, tenant, async (tx) =>
      (await tx.query<{ id: string }>('SELECT id FROM module_records ORDER BY id')).map(
        (r) => r.id,
      ),
    );
  expect(await ids(`${NEW}/PRJ-X`)).toEqual(['A-MANUAL', 'A-X', 'D-X']);
  expect(await ids(`${NEW}/PRJ-Y`)).toEqual(['D-Y']);
  expect(await ids(`${OLD}/PRJ-X`)).toEqual([]);
  await expect(
    withTenant(sql, `${NEW}/PRJ-X`, (tx) =>
      tx.query(
        `INSERT INTO module_records (tenant_id, module, id, payload, created_at, updated_at, marking)
         VALUES ('${NEW}/PRJ-Y', 'Demandas', 'D-LEAK', '{}', now(), now(), 'interno')`,
      ),
    ),
  ).rejects.toThrow(/row-level security/);
  await expect(
    withTenant(sql, `${NEW}/PRJ-X`, (tx) => tx.query('SELECT 1 FROM users')),
  ).rejects.toThrow(/permission denied/);
};

describe(`migration ${VERSION}`, () => {
  it('moves tenant ids, product names and the tenant role, keeping isolation', async () => {
    const { db, all, index } = await legacyDatabase();
    const before = { shapes: await shapes(db), keys: await foreignKeys(db) };
    const versions = await db.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM record_versions',
    );

    expect(await migrate(pgliteClient(db), all.slice(0, index + 1))).toEqual([VERSION]);

    await expectRenamed(db);
    await expectRoleAndIsolation(db);
    // Superusers can drop the old role: it is gone, not merely emptied.
    const old = await db.query("SELECT 1 FROM pg_roles WHERE rolname = 'mascli_tenant'");
    expect(old.rows).toEqual([]);

    // Row security, constraints and the history trigger are exactly as before.
    expect(await shapes(db)).toEqual(before.shapes);
    expect(await foreignKeys(db)).toEqual(before.keys);
    const trigger = await db.query<{ tgenabled: string }>(
      "SELECT tgenabled FROM pg_trigger WHERE tgname = 'module_records_history'",
    );
    expect(trigger.rows[0]?.tgenabled).toBe('O');
    // Re-keying rows is not a content change: it adds no history versions.
    const after = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM record_versions');
    expect(after.rows[0]?.n).toBe(versions.rows[0]?.n);
  });

  it('runs as a table owner without BYPASSRLS and can be applied twice', async () => {
    const { db, all, index } = await legacyDatabase();
    // A managed PostgreSQL owner role: owns the schema objects, forced RLS applies to it.
    await db.exec(`
      CREATE ROLE rename_owner NOSUPERUSER NOBYPASSRLS CREATEROLE;
      DO $$
      DECLARE r record;
      BEGIN
        FOR r IN SELECT c.oid::regclass AS rel FROM pg_class c
                 WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' LOOP
          EXECUTE format('ALTER TABLE %s OWNER TO rename_owner', r.rel);
        END LOOP;
        FOR r IN SELECT p.oid::regprocedure AS fn FROM pg_proc p
                 WHERE p.pronamespace = 'public'::regnamespace LOOP
          EXECUTE format('ALTER FUNCTION %s OWNER TO rename_owner', r.fn);
        END LOOP;
      END
      $$;
      GRANT USAGE, CREATE ON SCHEMA public TO rename_owner;
      SET ROLE rename_owner;
    `);

    expect(await migrate(pgliteClient(db), all.slice(0, index + 1))).toEqual([VERSION]);
    // Applying the SQL again finds nothing left to move and changes nothing.
    await db.exec(all[index]?.sql ?? '');
    await db.exec('RESET ROLE');

    await expectRenamed(db);
    await expectRoleAndIsolation(db);
  });

  it('keeps every login role that could use mascli_tenant able to use sipges_tenant', async () => {
    const { db, all, index } = await legacyDatabase();
    // Production shape: the managed login role is a member of mascli_tenant.
    await db.exec(`
      CREATE ROLE app_login LOGIN NOSUPERUSER NOBYPASSRLS;
      GRANT mascli_tenant TO app_login;
    `);

    await migrate(pgliteClient(db), all.slice(0, index + 1));

    const member = await db.query<{ ok: boolean }>(
      `SELECT pg_has_role('app_login', 'sipges_tenant', 'MEMBER') AS ok`,
    );
    expect(member.rows[0]?.ok).toBe(true);
    await db.exec('SET ROLE app_login; SET ROLE sipges_tenant; RESET ROLE;');
  });

  it('is a no-op on a database that never held MASCLI data', async () => {
    const db = trackTestDatabase(new PGlite());
    const all = await loadMigrations();
    await migrate(pgliteClient(db), all);
    const migration = all.find((m) => m.version === VERSION);
    expect(migration).toBeDefined();
    await db.exec(migration?.sql ?? '');
    const tenants = await db.query('SELECT 1 FROM tenants');
    expect(tenants.rows).toEqual([]);
  });
});
