import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { expect, it } from 'vitest';
import { pgliteClient } from '../../../platform/database/pglite.ts';
import { withTenant } from '../../../platform/database/tenant-transaction.ts';
import { createSqlSourceSettings } from './sql-source-settings.ts';
it('enforces source isolation, defaults, revision changes and atomic 15 minute polling', async () => {
  const db = new PGlite();
  try {
    const sql = pgliteClient(db);
    await sql.exec(
      "CREATE ROLE mascli_tenant NOLOGIN; CREATE TABLE tenants(tenant_id text PRIMARY KEY); INSERT INTO tenants VALUES ('A/P1'),('B/P2');",
    );
    await sql.exec(
      await readFile(
        new URL(
          '../../../platform/database/migrations/0024_authorized_sources.sql',
          import.meta.url,
        ),
        'utf8',
      ),
    );
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
