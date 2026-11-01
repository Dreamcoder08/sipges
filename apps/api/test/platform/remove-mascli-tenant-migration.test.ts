import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';
import { createTenancyService } from '../../src/contexts/tenancy/application/index.ts';
import { createSqlTenancyStore } from '../../src/contexts/tenancy/infrastructure/sql-tenancy-store.ts';
import { createSqlTenantDataReader } from '../../src/contexts/tenancy/infrastructure/sql-tenant-data-reader.ts';
import { pgliteClient } from '../../src/platform/database/pglite.ts';
import { loadMigrations, migrate } from '../../src/platform/database/migrator.ts';
import { withTenant } from '../../src/platform/database/tenant-transaction.ts';
import { trackTestDatabase } from '../support/test-database.ts';

const VERSION = '0031_remove_mascli_tenant';
const OLD = 'MASCLI/PRJ-SECHURA';
const NEW = 'SIPGES/PRJ-SECHURA';
const OTHER = 'SIPGES/PRJ-ALGARROBO';

type Row = Record<string, unknown>;
type Snapshot = Record<string, string[]>;

/** A database migrated up to the migration before the removal, with the SIPGES tenants set up. */
const database = async () => {
  const db = trackTestDatabase(new PGlite());
  const all = await loadMigrations();
  await migrate(
    pgliteClient(db),
    all.filter((m) => m.version < VERSION),
  );
  await db.exec(`
    INSERT INTO tenants (company_id, project_id, label) VALUES
      ('SIPGES', 'PRJ-SECHURA', 'Sechura'), ('SIPGES', 'PRJ-ALGARROBO', 'Algarrobo');
    INSERT INTO users (username, full_name, password_hash, role) VALUES
      ('ana', 'Ana', 'h', 'admin'), ('bruno', 'Bruno', 'h', 'analista');
    INSERT INTO grants (username, tenant_id) VALUES
      ('ana', '${NEW}'), ('ana', '${OTHER}'), ('bruno', '${NEW}');
  `);
  await record(db, NEW, 'D-SIPGES', { Tema: 'Agua' });
  await record(db, OTHER, 'D-ALGARROBO', { Tema: 'Tierra' });
  await db.exec(`
    INSERT INTO audit (tenant_id, ts, module, action, id) OVERRIDING SYSTEM VALUE
      VALUES ('${NEW}', now(), 'Demandas', 'create', 9001);
    INSERT INTO irsa_snapshots (tenant_id, ts, irsa, level, scores)
      VALUES ('${NEW}', now(), 40, 'Amarillo', '{}');
    INSERT INTO project_settings (tenant_id, settings, updated_by, updated_at)
      VALUES ('${NEW}', '{}', 'ana', now());
  `);
  // Later migrations are out of scope here: `migrate` must apply exactly the one under test.
  return { db, all: all.filter((m) => m.version <= VERSION) };
};

/** The MASCLI tenant the old Worker re-created, granted to the administrator. */
const addMascli = (db: PGlite) =>
  db.exec(`
    INSERT INTO tenants (company_id, project_id, label) VALUES ('MASCLI', 'PRJ-SECHURA', 'Sechura');
    INSERT INTO grants (username, tenant_id) VALUES ('ana', '${OLD}');
  `);

const record = (db: PGlite, tenant: string, id: string, payload: object) =>
  db.query(
    `INSERT INTO module_records (tenant_id, module, id, payload, created_at, updated_at, marking)
     VALUES ($1, 'Demandas', $2, $3::jsonb, now(), now(), 'interno')`,
    [tenant, id, JSON.stringify(payload)],
  );

const attachment = (db: PGlite, tenant: string, linked: string) =>
  db.query(
    `INSERT INTO attachments (tenant_id, id, storage_key, original_name, content_type, size_bytes,
       sha256, linked_module, record_module, linked_record_id, document_type, author, verification,
       notes, project_id, project_name, created_at)
     VALUES ($1, 'ATT-1', 'k', 'f.pdf', 'application/pdf', 1, repeat('a', 64), 'Demandas',
       'Demandas', $2, 'x', 'ana', 'x', '', 'PRJ-X', 'X', now())`,
    [tenant, linked],
  );

/** Every row of every table, as sorted JSON per table, to compare states exactly. */
const snapshot = async (db: PGlite): Promise<Snapshot> => {
  const tables = (
    await db.query<{ relname: string }>(
      `SELECT relname FROM pg_class
       WHERE relkind = 'r' AND relnamespace = 'public'::regnamespace
         AND relname <> 'schema_migrations' ORDER BY relname`,
    )
  ).rows;
  const out: Snapshot = {};
  for (const { relname } of tables) {
    const rows = await db.query<{ row: Row }>(`SELECT to_jsonb(t) AS row FROM "${relname}" t`);
    out[relname] = rows.rows.map((r) => JSON.stringify(r.row)).sort();
  }
  return out;
};

/** The snapshot without the rows that belong to (or are) the given tenant, grants included. */
const without = (snap: Snapshot, tenant: string): Snapshot =>
  Object.fromEntries(
    Object.entries(snap).map(([table, rows]) => [
      table,
      rows.filter((row) => {
        const parsed = JSON.parse(row) as Row;
        return parsed.tenant_id !== tenant;
      }),
    ]),
  );

const shapes = async (db: PGlite) =>
  (
    await db.query(
      `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
       WHERE relkind = 'r' AND relnamespace = 'public'::regnamespace ORDER BY relname`,
    )
  ).rows;

const foreignKeys = async (db: PGlite) =>
  (
    await db.query(
      `SELECT conname, pg_get_constraintdef(oid) AS def, convalidated FROM pg_constraint
       WHERE contype = 'f' AND connamespace = 'public'::regnamespace ORDER BY conname`,
    )
  ).rows;

const triggers = async (db: PGlite) =>
  (
    await db.query(
      `SELECT tgrelid::regclass::text AS rel, tgname, tgenabled FROM pg_trigger
       WHERE NOT tgisinternal ORDER BY 1, 2`,
    )
  ).rows;

const tenantIds = async (db: PGlite) =>
  (
    await db.query<{ tenant_id: string }>('SELECT tenant_id FROM tenants ORDER BY tenant_id')
  ).rows.map((r) => r.tenant_id);

/** No table keeps a MASCLI tenant id, and no grant or tenant row points to one. */
const expectNoMascli = async (db: PGlite) => {
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
      `SELECT count(*)::int AS n FROM "${table}" WHERE tenant_id LIKE 'MASCLI/%'`,
    );
    expect(left.rows[0]?.n, `${table} still holds a MASCLI tenant id`).toBe(0);
  }
  const companies = await db.query(`SELECT 1 FROM tenants WHERE company_id = 'MASCLI'`);
  expect(companies.rows).toEqual([]);
};

const scopesOf = async (db: PGlite, username: string) => {
  const sql = pgliteClient(db);
  const tenancy = createTenancyService({
    store: createSqlTenancyStore(sql),
    dataReader: createSqlTenantDataReader(sql),
    users: { exists: async () => true, adminUsernames: async () => [username] },
    clock: { now: () => new Date() },
  });
  // The service call behind GET /system/auth/scopes.
  return (await tenancy.listGranted(username)).map((t) => `${t.companyId}/${t.projectId}`);
};

describe(`migration ${VERSION}`, () => {
  it('deletes an empty MASCLI tenant and its grants, leaving SIPGES untouched', async () => {
    const { db, all } = await database();
    await addMascli(db);
    expect(await scopesOf(db, 'ana')).toEqual([OLD, OTHER, NEW]);
    const before = await snapshot(db);
    const form = {
      shapes: await shapes(db),
      keys: await foreignKeys(db),
      triggers: await triggers(db),
    };

    expect(await migrate(pgliteClient(db), all)).toEqual([VERSION]);

    await expectNoMascli(db);
    expect(await tenantIds(db)).toEqual([OTHER, NEW]);
    const grants = await db.query('SELECT username, tenant_id FROM grants ORDER BY 1, 2');
    expect(grants.rows).toEqual([
      { username: 'ana', tenant_id: OTHER },
      { username: 'ana', tenant_id: NEW },
      { username: 'bruno', tenant_id: NEW },
    ]);
    // Only the MASCLI tenant and its grants went away: every SIPGES row is as it was.
    expect(await snapshot(db)).toEqual(without(before, OLD));
    expect((await db.query('SELECT 1 FROM module_records')).rows).toHaveLength(2);
    expect((await db.query('SELECT 1 FROM project_settings')).rows).toHaveLength(1);

    // Row security, tenant foreign keys and the history trigger are exactly as before.
    expect(await shapes(db)).toEqual(form.shapes);
    expect(await foreignKeys(db)).toEqual(form.keys);
    expect(await triggers(db)).toEqual(form.triggers);

    // The project picker (GET /system/auth/scopes) lists the SIPGES projects only.
    expect(await scopesOf(db, 'ana')).toEqual([OTHER, NEW]);
    expect(await scopesOf(db, 'bruno')).toEqual([NEW]);

    // Applying the SQL again finds no MASCLI tenant and changes nothing.
    const done = await snapshot(db);
    await db.exec(all.find((m) => m.version === VERSION)?.sql ?? '');
    expect(await snapshot(db)).toEqual(done);
  });

  it('moves the data of a MASCLI tenant into the existing SIPGES tenant', async () => {
    const { db, all } = await database();
    await addMascli(db);
    await db.exec(`INSERT INTO grants (username, tenant_id) VALUES ('bruno', '${OLD}')`);
    await record(db, OLD, 'D-MASCLI', { Tema: 'Salud' });
    await record(db, OLD, 'D-MASCLI-2', { Tema: 'Vial' });
    await attachment(db, OLD, 'D-MASCLI');
    await db.exec(`
      INSERT INTO record_links (tenant_id, link_type, source_module, source_id, target_module,
        target_id, created_by, created_at)
      VALUES ('${OLD}', 'related', 'Demandas', 'D-MASCLI', 'Demandas', 'D-MASCLI-2', 'ana', now());
      INSERT INTO audit (tenant_id, ts, module, action, id) OVERRIDING SYSTEM VALUE
        VALUES ('${OLD}', now(), 'Demandas', 'create', 9002);
    `);
    const form = {
      shapes: await shapes(db),
      keys: await foreignKeys(db),
      triggers: await triggers(db),
    };
    const versions = await db.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM record_versions',
    );

    expect(await migrate(pgliteClient(db), all)).toEqual([VERSION]);

    await expectNoMascli(db);
    expect(await tenantIds(db)).toEqual([OTHER, NEW]);
    const records = await db.query('SELECT tenant_id, id FROM module_records ORDER BY 1, 2');
    expect(records.rows).toEqual([
      { tenant_id: OTHER, id: 'D-ALGARROBO' },
      { tenant_id: NEW, id: 'D-MASCLI' },
      { tenant_id: NEW, id: 'D-MASCLI-2' },
      { tenant_id: NEW, id: 'D-SIPGES' },
    ]);
    // The SIPGES data is still there, and the child rows followed their record.
    expect((await db.query('SELECT 1 FROM project_settings')).rows).toHaveLength(1);
    const joined = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM attachments a
       JOIN module_records r ON (r.tenant_id, r.module, r.id) = (a.tenant_id, a.record_module, a.linked_record_id)
       WHERE a.tenant_id = '${NEW}'`,
    );
    expect(joined.rows[0]?.n).toBe(1);
    const audit = await db.query('SELECT id, tenant_id FROM audit ORDER BY id');
    expect(audit.rows).toEqual([
      { id: 9001, tenant_id: NEW },
      { id: 9002, tenant_id: NEW },
    ]);
    // Whoever could read the moved data keeps access to the tenant it lives in now.
    const grants = await db.query('SELECT username, tenant_id FROM grants ORDER BY 1, 2');
    expect(grants.rows).toEqual([
      { username: 'ana', tenant_id: OTHER },
      { username: 'ana', tenant_id: NEW },
      { username: 'bruno', tenant_id: NEW },
    ]);
    expect(await scopesOf(db, 'ana')).toEqual([OTHER, NEW]);

    // Re-keying rows is not a content change, and the structure is exactly as before.
    const after = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM record_versions');
    expect(after.rows[0]?.n).toBe(versions.rows[0]?.n);
    expect(await shapes(db)).toEqual(form.shapes);
    expect(await foreignKeys(db)).toEqual(form.keys);
    expect(await triggers(db)).toEqual(form.triggers);

    // The moved record is visible to the SIPGES tenant under the runtime role, and only to it.
    const ids = (tenant: string) =>
      withTenant(pgliteClient(db), tenant, async (tx) =>
        (await tx.query<{ id: string }>('SELECT id FROM module_records ORDER BY id')).map(
          (r) => r.id,
        ),
      );
    expect(await ids(NEW)).toEqual(['D-MASCLI', 'D-MASCLI-2', 'D-SIPGES']);
    expect(await ids(OTHER)).toEqual(['D-ALGARROBO']);
    expect(await ids(OLD)).toEqual([]);
  });

  it('renames the MASCLI tenant when the SIPGES one does not exist', async () => {
    const { db, all } = await database();
    await db.exec(`
      INSERT INTO tenants (company_id, project_id, label) VALUES ('MASCLI', 'PRJ-X', 'X');
      INSERT INTO grants (username, tenant_id) VALUES ('bruno', 'MASCLI/PRJ-X');
    `);
    await record(db, 'MASCLI/PRJ-X', 'D-X', { Tema: 'Mar' });

    expect(await migrate(pgliteClient(db), all)).toEqual([VERSION]);

    await expectNoMascli(db);
    expect(await tenantIds(db)).toEqual([OTHER, NEW, 'SIPGES/PRJ-X']);
    const moved = await db.query('SELECT tenant_id, id FROM module_records WHERE id = $1', ['D-X']);
    expect(moved.rows).toEqual([{ tenant_id: 'SIPGES/PRJ-X', id: 'D-X' }]);
    const grants = await db.query(`SELECT username FROM grants WHERE tenant_id = 'SIPGES/PRJ-X'`);
    expect(grants.rows).toEqual([{ username: 'bruno' }]);
    const label = await db.query(`SELECT label FROM tenants WHERE tenant_id = 'SIPGES/PRJ-X'`);
    expect(label.rows).toEqual([{ label: 'X' }]);
  });

  it('stops on a key already present in the SIPGES tenant and changes nothing', async () => {
    const { db, all } = await database();
    await addMascli(db);
    await record(db, OLD, 'D-OTHER', { Tema: 'Salud' });
    await record(db, OLD, 'D-SIPGES', { Tema: 'Choque' });
    const before = await snapshot(db);
    const form = {
      shapes: await shapes(db),
      keys: await foreignKeys(db),
      triggers: await triggers(db),
    };

    await expect(migrate(pgliteClient(db), all)).rejects.toMatchObject({
      message: `Migration ${VERSION} failed`,
      cause: { message: expect.stringMatching(/MASCLI\/PRJ-SECHURA.*module_records/) },
    });

    // Every row of both tenants, and every grant, is exactly as before; nothing was deleted.
    expect(await snapshot(db)).toEqual(before);
    expect(await tenantIds(db)).toEqual([OLD, OTHER, NEW]);
    expect(await scopesOf(db, 'ana')).toEqual([OLD, OTHER, NEW]);
    const applied = await db.query(`SELECT 1 FROM schema_migrations WHERE version = '${VERSION}'`);
    expect(applied.rows).toEqual([]);
    // The lifted row security, foreign keys and triggers were restored by the rollback.
    expect(await shapes(db)).toEqual(form.shapes);
    expect(await foreignKeys(db)).toEqual(form.keys);
    expect(await triggers(db)).toEqual(form.triggers);
  });

  it('stops on a conflict in a table keyed by tenant alone', async () => {
    const { db, all } = await database();
    await addMascli(db);
    await db.exec(`
      INSERT INTO project_settings (tenant_id, settings, updated_by, updated_at)
        VALUES ('${OLD}', '{}', 'ana', now());
    `);
    const before = await snapshot(db);

    await expect(migrate(pgliteClient(db), all)).rejects.toMatchObject({
      cause: { message: expect.stringMatching(/project_settings/) },
    });
    expect(await snapshot(db)).toEqual(before);
  });

  it('changes nothing when no MASCLI tenant exists', async () => {
    const { db, all } = await database();
    const before = await snapshot(db);

    expect(await migrate(pgliteClient(db), all)).toEqual([VERSION]);

    expect(await snapshot(db)).toEqual(before);
    expect(await scopesOf(db, 'ana')).toEqual([OTHER, NEW]);
  });

  it('keeps the data as a table owner without BYPASSRLS, where forced RLS hides it', async () => {
    const { db, all } = await database();
    await addMascli(db);
    await record(db, OLD, 'D-MASCLI', { Tema: 'Salud' });
    // A managed PostgreSQL owner role: forced RLS applies to it, so it sees no tenant rows.
    await db.exec(`
      CREATE ROLE removal_owner NOSUPERUSER NOBYPASSRLS CREATEROLE;
      DO $$
      DECLARE r record;
      BEGIN
        FOR r IN SELECT c.oid::regclass AS rel FROM pg_class c
                 WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' LOOP
          EXECUTE format('ALTER TABLE %s OWNER TO removal_owner', r.rel);
        END LOOP;
        FOR r IN SELECT p.oid::regprocedure AS fn FROM pg_proc p
                 WHERE p.pronamespace = 'public'::regnamespace LOOP
          EXECUTE format('ALTER FUNCTION %s OWNER TO removal_owner', r.fn);
        END LOOP;
      END
      $$;
      GRANT USAGE, CREATE ON SCHEMA public TO removal_owner;
    `);
    const form = await shapes(db);
    await db.exec('SET ROLE removal_owner');
    try {
      expect(await migrate(pgliteClient(db), all)).toEqual([VERSION]);
    } finally {
      await db.exec('RESET ROLE');
    }

    await expectNoMascli(db);
    const records = await db.query('SELECT tenant_id, id FROM module_records ORDER BY 1, 2');
    expect(records.rows).toEqual([
      { tenant_id: OTHER, id: 'D-ALGARROBO' },
      { tenant_id: NEW, id: 'D-MASCLI' },
      { tenant_id: NEW, id: 'D-SIPGES' },
    ]);
    expect(await shapes(db)).toEqual(form);
  });

  it('renames the administrator display name only on an exact match', async () => {
    const { db, all } = await database();
    await db.exec(`
      INSERT INTO users (username, full_name, password_hash, role) VALUES
        ('root', 'Administración MASCLI Workers', 'h', 'admin'),
        ('carla', 'Ana MASCLI', 'h', 'analista'),
        ('dora', 'administración mascli workers', 'h', 'analista');
    `);

    expect(await migrate(pgliteClient(db), all)).toEqual([VERSION]);

    const users = await db.query('SELECT username, full_name FROM users ORDER BY username');
    expect(users.rows).toEqual([
      { username: 'ana', full_name: 'Ana' },
      { username: 'bruno', full_name: 'Bruno' },
      { username: 'carla', full_name: 'Ana MASCLI' },
      { username: 'dora', full_name: 'administración mascli workers' },
      { username: 'root', full_name: 'Administración SIPGES' },
    ]);
  });
});
