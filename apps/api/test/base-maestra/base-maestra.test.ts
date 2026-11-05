import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';
import { createSqlRecordStore } from '../../src/contexts/records/infrastructure/sql-record-store.ts';
import { loadMigrations, migrate } from '../../src/platform/database/migrator.ts';
import { pgliteClient } from '../../src/platform/database/pglite.ts';
import { baseMaestraId, planBaseMaestra } from '../../src/tools/base-maestra/plan.ts';
import { importBaseMaestra } from '../../src/tools/base-maestra/run.ts';
import { trackTestDatabase } from '../support/test-database.ts';

/** Synthetic stand-in for data/seed.json (the real file is never read in tests). */
const SEED = {
  Eventos: [{ ID_Evento: 'EV-T1', Fecha: '2026-10-01', Descripcion_Hecho: 'Hecho de prueba' }],
  Demandas: [{ ID_Demanda: 'D-T1', Descripcion: 'Demanda de prueba', Estado: 'Nueva' }],
  Directorio_Territorial: [
    {
      'Nombre actualizado 2026': 'Contacto de prueba',
      Cargo: 'Cargo de prueba',
      'Lugar / ámbito': 'Ciudad de prueba',
      Celular: '000 000 000',
    },
    { Nombre: 'Otro contacto de prueba', Cargo: 'Teniente gobernador' },
  ],
  Usuarios: [{ ID_Usuario: 'USR-T', Nombre: 'No se importa' }],
};

const database = async () => {
  const db = trackTestDatabase(new PGlite());
  const sql = pgliteClient(db);
  await migrate(sql, await loadMigrations());
  await sql.query(
    "INSERT INTO tenants (company_id, project_id, label, created_at) VALUES ('SIPGES', 'PRJ-T', 'Prueba', now())",
  );
  return { sql, store: createSqlRecordStore(sql) };
};
const now = () => new Date('2026-10-14T12:00:00Z');

// Regression (functional audit, errors 01 and 07): the prototype's Base Maestra can be
// loaded into the TypeScript database without inventing or overwriting records.
describe('Base Maestra import', () => {
  it('keeps module ids and gives rows without one a stable code', () => {
    const row = SEED.Directorio_Territorial[0] ?? {};
    expect(baseMaestraId('Eventos', { ID_Evento: 'EV-9' })).toBe('EV-9');
    expect(baseMaestraId('Directorio_Territorial', row)).toMatch(/^DIR-[0-9A-F]{8}$/);
    expect(baseMaestraId('Directorio_Territorial', { ...row })).toBe(
      baseMaestraId('Directorio_Territorial', row),
    );
  });

  it('reports unknown modules and malformed rows without record values', () => {
    const plan = planBaseMaestra(
      { Desconocido: [], Eventos: ['texto', { ID_Evento: {} }] },
      'PRJ-T',
    );
    expect(plan.problems).toEqual([
      'Módulo desconocido (clave omitida por privacidad)',
      'Eventos[0]: no es un objeto',
      'Eventos[1]: ID_Evento no es un código válido',
    ]);
  });

  it('dry-runs by default, then inserts only missing records with an audit entry', async () => {
    const { sql, store } = await database();
    const dry = await importBaseMaestra(store, 'SIPGES/PRJ-T', SEED, {
      apply: false,
      source: 'seed.json',
      now,
    });
    expect(dry.applied).toBe(false);
    expect(dry.modules).toEqual([
      { module: 'Eventos', en_archivo: 1, nuevos: 1, ya_existentes: 0 },
      { module: 'Demandas', en_archivo: 1, nuevos: 1, ya_existentes: 0 },
      { module: 'Directorio_Territorial', en_archivo: 2, nuevos: 2, ya_existentes: 0 },
    ]);
    expect(await sql.query('SELECT 1 FROM module_records')).toHaveLength(0);

    const applied = await importBaseMaestra(store, 'SIPGES/PRJ-T', SEED, {
      apply: true,
      source: 'seed.json',
      now,
    });
    expect(applied.applied).toBe(true);
    const contacts = await store.list('SIPGES/PRJ-T', 'Directorio_Territorial', {
      limit: 10,
      q: null,
    });
    expect(contacts.map((r) => r.payload)).toEqual(
      expect.arrayContaining([expect.objectContaining({ Celular: '000 000 000' })]),
    );
    expect(await store.list('SIPGES/PRJ-T', 'Usuarios', { limit: 10, q: null })).toEqual([]);
    const audit = await sql.query<{ action: string; detail: string }>(
      "SELECT action, detail FROM audit WHERE module = 'Directorio_Territorial'",
    );
    expect(audit).toEqual([
      { action: 'IMPORT', detail: 'Base Maestra: 2 registros nuevos desde seed.json' },
    ]);

    // A person edits a demand; re-running the import must not touch it.
    const [demand] = await store.list('SIPGES/PRJ-T', 'Demandas', { limit: 1, q: null });
    await sql.query(
      'UPDATE module_records SET payload = payload || \'{"Estado":"Cerrada"}\' WHERE id = \'D-T1\'',
    );
    const again = await importBaseMaestra(store, 'SIPGES/PRJ-T', SEED, {
      apply: true,
      source: 'seed.json',
      now,
    });
    expect(again.modules.every((m) => m.nuevos === 0)).toBe(true);
    const [after] = await store.list('SIPGES/PRJ-T', 'Demandas', { limit: 1, q: null });
    expect(demand?.payload.Estado).toBe('Nueva');
    expect(after?.payload.Estado).toBe('Cerrada');
  });

  it('applies nothing when the file has problems', async () => {
    const { sql, store } = await database();
    const report = await importBaseMaestra(
      store,
      'SIPGES/PRJ-T',
      { ...SEED, Desconocido: [] },
      { apply: true, source: 'seed.json', now },
    );
    expect(report.applied).toBe(false);
    expect(await sql.query('SELECT 1 FROM module_records')).toHaveLength(0);
  });
});

it('keeps a concurrent insert intact instead of merging the seed over it', async () => {
  const { sql, store } = await database();
  const target = {
    existing: store.existing,
    importBatch: async (...args: Parameters<typeof store.importBatch>) => {
      await store.importBatch(
        args[0],
        args[1],
        [
          {
            id: 'D-T1',
            payload: { ID_Demanda: 'D-T1', Estado: 'Cerrada', Descripcion: 'Registro concurrente' },
          },
        ],
        { action: 'IMPORT', detail: 'Carga concurrente de prueba' },
        now(),
      );
      return store.importBatch(...args);
    },
  };
  const report = await importBaseMaestra(
    target,
    'SIPGES/PRJ-T',
    { Demandas: SEED.Demandas },
    { apply: true, source: 'seed.json', now },
  );
  expect((await store.get('SIPGES/PRJ-T', 'Demandas', 'D-T1'))?.payload.Estado).toBe('Cerrada');
  expect(report.modules[0]).toMatchObject({ nuevos: 0, ya_existentes: 1 });
  expect(await sql.query("SELECT 1 FROM audit WHERE detail LIKE 'Base Maestra:%'")).toHaveLength(0);
});
it('never echoes unknown keys or duplicate record identifiers in validation output', () => {
  const secret = 'valor-privado-de-prueba';
  const plan = planBaseMaestra(
    {
      [secret]: [],
      Demandas: [{ ID_Demanda: secret }, { ID_Demanda: secret }],
    },
    'PRJ-T',
  );
  expect(plan.problems).toHaveLength(2);
  expect(JSON.stringify(plan.problems)).not.toContain(secret);
});

it('rejects actual NULs in nested values and keys, but allows a literal escape sequence', () => {
  for (const payload of [
    { Descripcion: 'Texto\u0000' },
    { 'Clave\u0000': 'Texto' },
    { Detalle: ['Texto\u0000'] },
  ]) {
    const plan = planBaseMaestra({ Demandas: [payload] }, 'PRJ-T');
    expect(plan.problems).toEqual(['Demandas[0]: contiene caracteres NUL']);
    expect(plan.modules[0]?.items).toHaveLength(0);
  }
  expect(
    planBaseMaestra({ Demandas: [{ Descripcion: 'Texto\\u0000' }] }, 'PRJ-T').problems,
  ).toEqual([]);
});

describe('rows naming another project', () => {
  const FOREIGN = 'Eventos[1]: Proyecto_ID no corresponde al proyecto activo';

  it.each([['PRJ-OTRO'], [' '], ['prj-t'], [0], [5], [false], [true], [{}], [[]]])(
    'refuses %j by position without echoing the value',
    (value) => {
      const plan = planBaseMaestra(
        { Eventos: [{ ID_Evento: 'EV-1' }, { ID_Evento: 'EV-2', Proyecto_ID: value }] },
        'PRJ-T',
      );
      expect(plan.problems).toEqual([FOREIGN]);
      expect(plan.modules[0]?.items.map((item) => item.id)).toEqual(['EV-1']);
    },
  );

  it('keeps a row with an empty, missing or matching Proyecto_ID exactly as it is', () => {
    const rows = [
      { ID_Evento: 'EV-1' },
      { ID_Evento: 'EV-2', Proyecto_ID: null },
      { ID_Evento: 'EV-3', Proyecto_ID: '' },
      { ID_Evento: 'EV-4', Proyecto_ID: 'PRJ-T' },
    ];
    const plan = planBaseMaestra({ Eventos: rows }, 'PRJ-T');
    expect(plan.problems).toEqual([]);
    expect(plan.modules[0]?.items.map((item) => item.payload)).toEqual(rows);
  });

  it('never compares the Proyecto_ID of the modules it does not import', () => {
    expect(planBaseMaestra({ Proyectos: [{ Proyecto_ID: 'PRJ-OTRO' }] }, 'PRJ-T').problems).toEqual(
      [],
    );
  });

  it('reports the row in a dry run and refuses to write with --apply', async () => {
    const { sql, store } = await database();
    const seed = {
      Eventos: [{ ID_Evento: 'EV-1' }, { ID_Evento: 'EV-2', Proyecto_ID: 'PRJ-OTRO' }],
    };
    const options = { source: 'seed.json', now };
    const dry = await importBaseMaestra(store, 'SIPGES/PRJ-T', seed, { ...options, apply: false });
    expect(dry).toEqual({
      applied: false,
      modules: [{ module: 'Eventos', en_archivo: 2, nuevos: 1, ya_existentes: 0 }],
      problems: [FOREIGN],
    });
    const applied = await importBaseMaestra(store, 'SIPGES/PRJ-T', seed, {
      ...options,
      apply: true,
    });
    expect(applied.applied).toBe(false);
    expect(applied.problems).toEqual([FOREIGN]);
    expect(await sql.query('SELECT 1 FROM module_records')).toHaveLength(0);
    expect(await sql.query('SELECT 1 FROM audit')).toHaveLength(0);
  });

  it('compares against the project of the target scope, not the default one', async () => {
    const { store } = await database();
    const seed = { Eventos: [{ ID_Evento: 'EV-1', Proyecto_ID: 'PRJ-T' }] };
    const options = { apply: false, source: 'seed.json', now };
    expect((await importBaseMaestra(store, 'SIPGES/PRJ-T', seed, options)).problems).toEqual([]);
    expect((await importBaseMaestra(store, 'OTRA/PRJ-T', seed, options)).problems).toEqual([]);
    expect((await importBaseMaestra(store, 'SIPGES/PRJ-B', seed, options)).problems).toEqual([
      'Eventos[0]: Proyecto_ID no corresponde al proyecto activo',
    ]);
  });
});
