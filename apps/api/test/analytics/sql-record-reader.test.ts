import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';
import {
  createSqlAnalyticsRecordReader,
  createSqlDatedRecordReader,
} from '../../src/contexts/analytics/infrastructure/sql-analytics-record-reader.ts';
import { pgliteClient } from '../../src/platform/database/pglite.ts';
import { trackTestDatabase } from '../support/test-database.ts';

const SECHURA = { companyId: 'SIPGES', projectId: 'PRJ-SECHURA' };

// Minimal synthetic stand-in for the T6 table and the T5 tenant role.
const setup = async (withTable: boolean, forced = true) => {
  const db = trackTestDatabase(new PGlite());
  const sql = pgliteClient(db);
  await sql.exec(
    `CREATE ROLE sipges_tenant NOLOGIN; GRANT USAGE ON SCHEMA public TO sipges_tenant;`,
  );
  if (withTable)
    await sql.exec(`
      CREATE TABLE module_records (tenant_id text NOT NULL, module text NOT NULL, id text NOT NULL,
        payload jsonb NOT NULL, updated_at timestamptz NOT NULL, PRIMARY KEY (tenant_id, module, id));
      ALTER TABLE module_records ENABLE ROW LEVEL SECURITY;
      ${forced ? 'ALTER TABLE module_records FORCE ROW LEVEL SECURITY;' : ''}
      CREATE POLICY tenant_isolation ON module_records
        USING (tenant_id = current_setting('app.tenant_id', true));
      GRANT SELECT ON module_records TO sipges_tenant;
      INSERT INTO module_records VALUES
        ('SIPGES/PRJ-SECHURA','Eventos','e-old','{"Tema":"old"}','2026-01-01'),
        ('SIPGES/PRJ-SECHURA','Eventos','e-new','{"Tema":"new"}','2026-02-01'),
        ('SIPGES/PRJ-SECHURA','Actores','a1','{}','2026-01-01'),
        ('ACME/NORTE','Eventos','n1','{"Tema":"north"}','2026-03-01');
    `);
  return Object.assign(createSqlAnalyticsRecordReader(sql), {
    dated: createSqlDatedRecordReader(sql),
  });
};

describe('SQL analytics record reader', () => {
  it('returns empty lists per module when module_records does not exist yet', async () => {
    const reader = await setup(false);
    expect(await reader.read(SECHURA, ['Eventos', 'Actores'])).toEqual({
      Eventos: [],
      Actores: [],
    });
  });

  it('reads only the tenant rows of the requested modules, newest first', async () => {
    const reader = await setup(true);
    expect(await reader.read(SECHURA, ['Eventos', 'Fuentes'])).toEqual({
      Eventos: [
        { id: 'e-new', payload: { Tema: 'new' } },
        { id: 'e-old', payload: { Tema: 'old' } },
      ],
      Fuentes: [],
    });
    expect(await reader.read({ companyId: 'ACME', projectId: 'NORTE' }, ['Eventos'])).toEqual({
      Eventos: [{ id: 'n1', payload: { Tema: 'north' } }],
    });
  });

  it('refuses to read a module_records table without forced row-level security', async () => {
    const reader = await setup(true, false);
    await expect(reader.read(SECHURA, ['Eventos'])).rejects.toThrow(
      'Analytics requires forced tenant row-level security',
    );
  });

  it('reads records with their last update for conflict risk, never across tenants', async () => {
    const reader = await setup(true);
    expect(await reader.dated.read(SECHURA, ['Eventos'])).toEqual([
      {
        module: 'Eventos',
        id: 'e-new',
        payload: { Tema: 'new' },
        updatedAt: '2026-02-01T00:00:00.000Z',
      },
      {
        module: 'Eventos',
        id: 'e-old',
        payload: { Tema: 'old' },
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ]);
    const north = await reader.dated.read({ companyId: 'ACME', projectId: 'NORTE' }, ['Eventos']);
    expect(north.map((r) => r.id)).toEqual(['n1']);
    await expect(
      reader.dated.read({ companyId: 'X', projectId: 'Y' }, ['Eventos']),
    ).resolves.toEqual([]);
  });
});
