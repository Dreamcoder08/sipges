import { expect, it } from 'vitest';
import { qualityFieldLabel, qualityIssues, sourceInventory } from './model.ts';

it('uses only exact accessible evidence and event references and never changes records', () => {
  const rows = {
    actores: [
      {
        _id: 'A',
        'Nombre_Actor/Organizacion': 'Actor sintético',
        Tipo_Actor: 'Comunal',
        Influencia: 'Alta',
        Posicion_Proyecto: 'Favorable',
        Territorio: 'Norte',
        Fuente_ID: 'F',
      },
    ],
    alertas: [
      {
        _id: 'AL',
        Dimension: 'G',
        Nivel_Preliminar: 'Rojo',
        'Evento/Registro_Origen': 'EV',
        Fuente_ID: 'F',
      },
    ],
    eventos: [{ _id: 'EV', Territorio: 'Norte', Fuente_ID: 'F' }],
    demandas: [],
    acciones: [],
    compromisos: [],
    fuentes: [{ _id: 'F', Archivo_Fuente: 'Acta' }],
  };
  const before = structuredClone(rows);
  expect(qualityIssues(rows)).toEqual([]);
  expect(rows).toEqual(before);
  expect(
    qualityIssues({ ...rows, fuentes: [] }).filter((i) => i.field === 'Fuente_ID'),
  ).toHaveLength(3);
});

it('keeps absent, unclassifiable, and ambiguous values in the review queue', () => {
  const issues = qualityIssues({
    actores: [{ _id: 'A', Influencia: 'constructor', Posicion_Proyecto: 'Institucional' }],
    alertas: [
      {
        _id: 'AL',
        Dimension: 'Desconocida',
        Nivel_Preliminar: 'Otro',
        'Evento/Registro_Origen': 'EV',
      },
    ],
    eventos: [
      { _id: 'EV', Territorio: 'Uno' },
      { _id: 'other', ID_Evento: 'EV', Territorio: 'Dos' },
    ],
    demandas: [],
    acciones: [],
    compromisos: [],
    fuentes: [],
  });
  expect(issues.find((i) => i.module === 'actores' && i.field === 'Influencia')?.reason).toContain(
    'clasificable',
  );
  expect(issues.find((i) => i.module === 'alertas' && i.field === 'Territorio')?.reason).toContain(
    'Sin territorio',
  );
  expect(issues.some((i) => i.module === 'actores' && i.field === 'Tipo_Actor')).toBe(true);
});

it('inventories metadata without claiming recoverability and makes truncation explicit', () => {
  const sources = [{ _id: 'F', Archivo_Fuente: 'Informe original.pdf' }];
  expect(sourceInventory(sources, [], false)[0]).toMatchObject({
    id: 'F',
    files: [],
    status: 'Sin archivo asociado',
  });
  expect(sourceInventory(sources, [], true)[0]?.status).toBe(
    'Asociación no comprobada: inventario limitado',
  );
});

it('keeps documentary placeholder identities in the quality queue without altering evidence', () => {
  const row = {
    _id: 'A',
    'Nombre_Actor/Organizacion': 'Por identificar (fuente sintética.pdf)',
    Revision_Documental_ID: 'R',
    'Rol/Relacion': 'Fragmento sintético',
  };
  const before = structuredClone(row);
  const issues = qualityIssues({
    actores: [row],
    alertas: [],
    eventos: [],
    demandas: [],
    acciones: [],
    compromisos: [],
    fuentes: [],
  });
  expect(issues).toContainEqual(
    expect.objectContaining({
      id: 'A',
      field: 'Nombre_Actor/Organizacion',
      reason: 'Mención documental pendiente de identificar; conservar la evidencia original',
    }),
  );
  expect(row).toEqual(before);
});

it('names every field it flags by its form label, never by its stored key', () => {
  // One empty row per module: every rule that can fire on an empty record fires.
  const empty = (id: string) => [{ _id: id }];
  const issues = qualityIssues({
    actores: empty('A'),
    alertas: empty('AL'),
    eventos: empty('EV'),
    demandas: empty('D'),
    acciones: empty('AC'),
    compromisos: empty('C'),
    fuentes: [],
  });
  const fields = [...new Set(issues.map((issue) => `${issue.module}/${issue.field}`))];
  expect(fields).toContain('eventos/Fuente_ID');
  expect(qualityFieldLabel({ module: 'eventos', field: 'Fuente_ID' })).toBe('Referencia de fuente');
  // Keys look like `Fuente_ID` or `Nombre_Actor/Organizacion`; labels never do.
  for (const issue of issues) expect(qualityFieldLabel(issue)).not.toMatch(/_|\S\/\S/);
});
