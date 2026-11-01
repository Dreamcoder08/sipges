import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { expect, it } from 'vitest';
import type { SqlClient } from '../../../platform/database/sql-client.ts';
import { pgliteClient } from '../../../platform/database/pglite.ts';
import { withTenant } from '../../../platform/database/tenant-transaction.ts';
import { createSqlSourceSettings } from './sql-source-settings.ts';
const setupTables = async (sql: SqlClient) => {
  await sql.exec(`
    CREATE ROLE mascli_tenant NOLOGIN;
    CREATE ROLE source_owner NOLOGIN NOSUPERUSER NOBYPASSRLS;
    GRANT mascli_tenant TO source_owner;
    GRANT CREATE ON SCHEMA public TO source_owner;
    CREATE TABLE tenants(tenant_id text PRIMARY KEY);
    INSERT INTO tenants VALUES ('A/P1'),('B/P2');
    CREATE TABLE audit(id integer PRIMARY KEY, tenant_id text NOT NULL REFERENCES tenants);
    INSERT INTO audit VALUES (100, 'A/P1'), (200, 'B/P2');
    ALTER TABLE audit ENABLE ROW LEVEL SECURITY;
    ALTER TABLE audit FORCE ROW LEVEL SECURITY;
    CREATE POLICY tenant_rows ON audit
      USING (tenant_id = current_setting('app.tenant_id', true))
      WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
    GRANT SELECT ON audit TO mascli_tenant;
    CREATE TABLE automation_cursors (
      tenant_id text PRIMARY KEY REFERENCES tenants,
      last_audit_id integer NOT NULL DEFAULT 0
    );
    ALTER TABLE automation_cursors ENABLE ROW LEVEL SECURITY;
    CREATE POLICY tenant_rows ON automation_cursors
      USING (tenant_id = current_setting('app.tenant_id', true))
      WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
    GRANT SELECT, INSERT, UPDATE ON automation_cursors TO mascli_tenant;
  `);
  await sql.exec(
    await readFile(
      new URL('../../../platform/database/migrations/0024_authorized_sources.sql', import.meta.url),
      'utf8',
    ),
  );
  // Migration 0024 predates the rename and grants to mascli_tenant; withTenant uses the new name.
  await sql.exec(`
    ALTER ROLE mascli_tenant RENAME TO sipges_tenant;
    ALTER TABLE tenants OWNER TO source_owner;
    ALTER TABLE audit OWNER TO source_owner;
    ALTER TABLE automation_cursors OWNER TO source_owner;
    ALTER TABLE source_import_settings OWNER TO source_owner;
    SET ROLE source_owner;
  `);
};
it('enforces source isolation, defaults, revision changes and atomic 15 minute polling', async () => {
  const db = new PGlite();
  try {
    const sql = pgliteClient(db);
    await setupTables(sql);
    const settings = createSqlSourceSettings(sql);
    expect((await settings.get('A/P1')).enabled).toBe(false);
    expect(await settings.activeTenants()).toEqual([]);
    const config = await settings.save(
      'A/P1',
      {
        enabled: true,
        query: 'agua',
        territory: 'Documentado',
        authorization_note: 'Autorización sintética',
      },
      'synthetic',
      '2026-10-17T12:00:00Z',
    );
    expect((await settings.get('B/P2')).enabled).toBe(false);
    expect(await settings.activeTenants()).toEqual(['A/P1']);
    const claims = await Promise.all([
      settings.claimPoll('A/P1', config.revision, '2026-10-17T12:00:00Z'),
      settings.claimPoll('A/P1', config.revision, '2026-10-17T12:00:00Z'),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(await settings.claimPoll('A/P1', config.revision, '2026-10-17T12:14:59Z')).toBe(false);
    expect(await settings.claimPoll('A/P1', config.revision, '2026-10-17T12:15:00Z')).toBe(true);
    const changed = await settings.save(
      'A/P1',
      { enabled: false, query: '', territory: '', authorization_note: '' },
      'synthetic',
      '2026-10-17T12:16:00Z',
    );
    expect(changed.revision).toBe(config.revision + 1);
    expect(await settings.claimPoll('A/P1', config.revision, '2026-10-17T13:00:00Z')).toBe(false);
    expect(
      await withTenant(sql, 'B/P2', (tx) =>
        tx.query("SELECT tenant_id FROM source_import_settings WHERE tenant_id='A/P1'"),
      ),
    ).toEqual([]);
    await expect(
      withTenant(sql, 'B/P2', (tx) =>
        tx.query(
          "UPDATE source_import_settings SET enabled=true WHERE tenant_id='A/P1' RETURNING tenant_id",
        ),
      ),
    ).resolves.toEqual([]);
  } finally {
    await db.close();
  }
});

it('discovers enabled sources as an ordinary owner and preserves scoped cursor history atomically', async () => {
  const db = new PGlite();
  try {
    const sql = pgliteClient(db);
    await setupTables(sql);
    const [owner] = await sql.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user',
    );
    expect(owner).toEqual({ rolsuper: false, rolbypassrls: false });
    const settings = createSqlSourceSettings(sql);
    const enabled = {
      enabled: true,
      query: '',
      territory: '',
      authorization_note: 'Synthetic authorization',
    };
    await settings.save('A/P1', enabled, 'synthetic', '2026-10-17T12:00:00Z');
    // Ordinary owners cannot enumerate forced-RLS source rows outside tenant transactions.
    expect(await sql.query('SELECT tenant_id FROM source_import_settings')).toEqual([]);
    expect(await sql.query('SELECT tenant_id,last_audit_id FROM automation_cursors')).toEqual([
      { tenant_id: 'A/P1', last_audit_id: 100 },
    ]);
    expect(await settings.activeTenants()).toEqual(['A/P1']);
    await settings.save(
      'B/P2',
      { ...enabled, enabled: false },
      'synthetic',
      '2026-10-17T12:01:00Z',
    );
    expect(
      await sql.query("SELECT tenant_id FROM automation_cursors WHERE tenant_id='B/P2'"),
    ).toEqual([]);
    // A pre-existing rules cursor must retain its place when this connector is enabled.
    await sql.query("INSERT INTO automation_cursors VALUES ('B/P2', 42)");
    await settings.save('B/P2', enabled, 'synthetic', '2026-10-17T12:02:00Z');
    expect(
      await sql.query("SELECT last_audit_id FROM automation_cursors WHERE tenant_id='B/P2'"),
    ).toEqual([{ last_audit_id: 42 }]);
    await settings.save(
      'A/P1',
      { ...enabled, enabled: false },
      'synthetic',
      '2026-10-17T12:03:00Z',
    );
    expect(await settings.activeTenants()).toEqual(['B/P2']);
    expect(
      await sql.query("SELECT last_audit_id FROM automation_cursors WHERE tenant_id='A/P1'"),
    ).toEqual([{ last_audit_id: 100 }]);
    // If cursor registration fails, enabling must roll back with it.
    await sql.exec(
      "CREATE FUNCTION reject_source_cursor() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic cursor registration failure'; END $$; CREATE TRIGGER reject_source_cursor BEFORE INSERT ON automation_cursors FOR EACH ROW EXECUTE FUNCTION reject_source_cursor();",
    );
    await expect(
      settings.save('A/P1', enabled, 'synthetic', '2026-10-17T12:04:00Z'),
    ).rejects.toThrow('Synthetic cursor registration failure');
    expect((await settings.get('A/P1')).enabled).toBe(false);
  } finally {
    await db.close();
  }
});
