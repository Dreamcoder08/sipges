import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';
import { pgliteClient } from '../../src/platform/database/pglite.ts';
import { loadMigrations, migrate } from '../../src/platform/database/migrator.ts';
import { trackTestDatabase } from '../support/test-database.ts';

const VERSION = '0019_remove_demo_records';

const record = (
  tenant: string,
  id: string,
  payload: Record<string, unknown>,
  marking = 'interno',
) => [tenant, 'Demandas', id, JSON.stringify(payload), marking] as const;

describe(`migration ${VERSION}`, () => {
  it('deletes only the synthetic academic case, in every tenant, through forced RLS', async () => {
    const db = trackTestDatabase(new PGlite());
    const all = await loadMigrations();
    const index = all.findIndex((m) => m.version === VERSION);
    expect(index).toBeGreaterThan(0);
    await migrate(pgliteClient(db), all.slice(0, index));

    await db.exec(`
      INSERT INTO tenants (company_id, project_id, label) VALUES
        ('SIPGES', 'PRJ-SECHURA', 'Sechura'), ('SIPGES', 'PRJ-OTRO', 'Otro');
    `);
    const rows = [
      record('SIPGES/PRJ-SECHURA', 'D-REAL', { ID_Demanda: 'D-REAL', Tema: 'Agua' }),
      record('SIPGES/PRJ-SECHURA', 'DEMO-D-01', { Dato_Sintetico: true, Demo_ID: 'DEMO-D-01' }),
      record(
        'SIPGES/PRJ-SECHURA',
        'DEMO-D-02',
        { Demo_Dataset: 'mascli-academic-v1' },
        'restringido',
      ),
      record('SIPGES/PRJ-OTRO', 'DEMO-D-03', { Dato_Sintetico: true }),
      record('SIPGES/PRJ-OTRO', 'D-FALSO', { Dato_Sintetico: false, Demo_Dataset: '' }),
    ];
    for (const row of rows)
      await db.query(
        `INSERT INTO module_records (tenant_id, module, id, payload, created_at, updated_at, marking)
         VALUES ($1, $2, $3, $4::jsonb, now(), now(), $5)`,
        [...row],
      );
    await db.exec(`
      INSERT INTO irsa_snapshots (tenant_id, ts, irsa, level, scores, note) VALUES
        ('SIPGES/PRJ-SECHURA', now(), 40, 'Amarillo', '{}', 'DEMO mascli-academic-v1: corte inicial sintético'),
        ('SIPGES/PRJ-SECHURA', now(), 41, 'Amarillo', '{}', 'Corte real');
    `);

    // Run as a table owner without BYPASSRLS, like a managed PostgreSQL owner role.
    await db.exec(`
      CREATE ROLE demo_cleanup NOSUPERUSER NOBYPASSRLS;
      ALTER TABLE module_records OWNER TO demo_cleanup;
      ALTER TABLE attachments OWNER TO demo_cleanup;
      ALTER TABLE irsa_snapshots OWNER TO demo_cleanup;
      GRANT USAGE, CREATE ON SCHEMA public TO demo_cleanup;
      GRANT SELECT ON tenants TO demo_cleanup;
      GRANT SELECT, INSERT ON schema_migrations TO demo_cleanup;
      SET ROLE demo_cleanup;
    `);
    expect(await migrate(pgliteClient(db), all.slice(0, index + 1))).toEqual([VERSION]);
    await db.exec('RESET ROLE');

    const left = await db.query<{ id: string }>('SELECT id FROM module_records ORDER BY id');
    expect(left.rows.map((r) => r.id)).toEqual(['D-FALSO', 'D-REAL']);
    const notes = await db.query<{ note: string }>('SELECT note FROM irsa_snapshots');
    expect(notes.rows.map((r) => r.note)).toEqual(['Corte real']);
    const deleted = await db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM record_versions WHERE operation = 'DELETE'",
    );
    expect(deleted.rows[0]?.n).toBe(3);
  });
});
