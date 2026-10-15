import { expect, it } from 'vitest';
import { alertHeatmap, recordedLevel } from './alert-heatmap.ts';
import { actorGroups } from './actor-map.ts';

it('uses the highest documented level and keeps missing levels and territories explicit', () => {
  const map = alertHeatmap([
    {
      _id: 'AL-1',
      Dimension: 'G - Gobernanza',
      Territorio: 'Comunidad de prueba',
      Nivel_Preliminar: 'Amarillo',
    },
    { _id: 'AL-2', Dimension: 'G', Territorio: 'Comunidad de prueba', Nivel_Preliminar: 'Rojo' },
    { _id: 'AL-3', Dimension: 'A', Nivel_Preliminar: 'Por verificar' },
    {
      _id: 'AL-4',
      Dimension: 'G',
      Territorio: 'Comunidad de prueba',
      Nivel_Preliminar: 'Rojo',
      Estado: ' Cerrada ',
    },
  ]);
  expect(map.active).toHaveLength(3);
  expect(
    map.cells.find((c) => c.dimension === 'G' && c.territory === 'Comunidad de prueba'),
  ).toMatchObject({ level: 'Rojo', rows: [{ _id: 'AL-1' }, { _id: 'AL-2' }] });
  expect(
    map.cells.find((c) => c.dimension === 'A' && c.territory === 'Sin territorio registrado'),
  ).toMatchObject({ level: null, unknown: 1 });
  expect(
    map.cells.find((c) => c.dimension === 'D' && c.territory === 'Comunidad de prueba'),
  ).toMatchObject({ level: null, rows: [] });
});

it('does not infer geography from narrative or invent a dimension', () => {
  const map = alertHeatmap([
    { _id: 'AL-1', Causa: 'Riesgo en una comunidad mencionada', Dimension: 'Desconocida' },
  ]);
  expect(map.territories).toEqual(['Sin territorio registrado']);
  expect(map.cells.find((c) => c.dimension === '?')).toMatchObject({ rows: [{ _id: 'AL-1' }] });
  expect(alertHeatmap([]).cells).toEqual([]);
});

it('uses an exact event reference and gives the alert own territory priority', () => {
  const events = [{ _id: 'EV-1', Territorio: 'Territorio documentado' }];
  expect(
    alertHeatmap([{ _id: 'AL-1', 'Evento/Registro_Origen': 'EV-1' }], events).territories,
  ).toEqual(['Territorio documentado']);
  expect(
    alertHeatmap(
      [{ _id: 'AL-2', 'Evento/Registro_Origen': 'EV-1', Territorio: 'Territorio explícito' }],
      events,
    ).territories,
  ).toEqual(['Territorio explícito']);
  expect(
    alertHeatmap([{ _id: 'AL-3', 'Evento/Registro_Origen': 'Consulte EV-1' }], events).territories,
  ).toEqual(['Sin territorio registrado']);
});

it('classifies actors by their stored type and influence without manufacturing relationships', () => {
  const groups = actorGroups([
    { _id: 'A-1', Tipo_Actor: 'Comunal', Influencia: 'Alta', Posicion_Proyecto: 'Favorable' },
    { _id: 'A-2', Tipo_Actor: 'Comunal', Influencia: 'alta', Posicion_Proyecto: 'Expectante' },
    { _id: 'A-3', Tipo_Actor: 'Productivo', Influencia: 'Media–Alta' },
    { _id: 'A-4', Influencia: 'Por verificar' },
  ]);
  expect(groups.find((g) => g.type === 'Comunal')).toMatchObject({
    band: 0,
    rows: [{ _id: 'A-1' }, { _id: 'A-2' }],
  });
  expect(groups.find((g) => g.type === 'Productivo')).toMatchObject({ band: 1 });
  expect(groups.find((g) => g.type === 'Sin tipo registrado')).toMatchObject({
    band: null,
    rows: [{ _id: 'A-4' }],
  });
  expect(groups.reduce((sum, g) => sum + g.rows.length, 0)).toBe(4);
});

it('keeps inherited object keys unclassified', () => {
  for (const value of ['__proto__', 'constructor', 'toString']) {
    expect(recordedLevel({ _id: value, Nivel_Preliminar: value })).toBeNull();
  }
});
