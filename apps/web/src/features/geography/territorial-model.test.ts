import { describe, expect, it } from 'vitest';
import { localityOf } from './localities.ts';
import { atCursor, filterPoints, mapPoints, monthlyCounts, monthsOf } from './territorial-model.ts';

describe('territorial map model', () => {
  it('finds the locality named in a free-text territory, longest name first', () => {
    expect(localityOf('Caserío en Bellavista de la Union, Sechura')?.name).toBe(
      'Bellavista de la Unión',
    );
    expect(localityOf('puerto de BAYOVAR')?.name).toBe('Bayóvar');
    expect(localityOf('Vice, Sechura')?.name).toBe('Vice');
    expect(localityOf('Lima')).toBeNull();
    expect(localityOf(undefined)).toBeNull();
  });

  it('places located records of the project and spreads those sharing a place', () => {
    const { points, unlocated } = mapPoints(
      {
        Eventos: [
          {
            _id: 'E-1',
            Territorio: 'Vice',
            Dimension_Principal: 'N - Narrativas',
            Fecha: '2026-10-02',
          },
          { _id: 'E-2', Territorio: 'Vice', Dimension_Principal: 'G', Fecha: '2026-09-20' },
          { _id: 'E-3', Territorio: 'Sin dato', Proyecto_ID: 'PRJ-SECHURA' },
          { _id: 'E-4', Territorio: 'Vice', Proyecto_ID: 'OTRO' },
        ],
        Demandas: [{ _id: 'D-1', Territorio: 'x', Latitud: '-5.6', Longitud: '-80.9' }],
        Actores: [],
      },
      'PRJ-SECHURA',
    );
    expect(unlocated).toBe(1);
    expect(points.map((p) => [p.id, p.dimension, p.locality])).toEqual([
      ['E-1', 'N', 'Vice'],
      ['E-2', 'G', 'Vice'],
      ['D-1', 'D', 'x'],
    ]);
    expect(points[0]?.at).toEqual([-80.7767, -5.4183]);
    expect(points[1]?.at).not.toEqual(points[0]?.at);
    expect(points[2]?.at).toEqual([-80.9, -5.6]);
    expect(monthsOf(points)).toEqual(['2026-10', '2026-09']);
    const none = { layer: '', dimension: '', locality: '', from: '', to: '' };
    expect(
      filterPoints(points, { ...none, layer: 'Eventos', locality: 'vice', from: '2026-10' }),
    ).toHaveLength(1);
    expect(filterPoints(points, none)).toHaveLength(3);
    // A time range hides undated points.
    expect(filterPoints(points, { ...none, to: '2026-09' }).map((p) => p.id)).toEqual(['E-2']);
    expect(monthlyCounts(points)).toEqual([
      { month: '2026-09', count: 1 },
      { month: '2026-10', count: 1 },
    ]);
  });

  it('counts points per month over a continuous span', () => {
    const at = (id: string, date: string) =>
      ({ id, date }) as unknown as Parameters<typeof monthlyCounts>[0][number];
    expect(
      monthlyCounts([
        at('1', '2025-11-03'),
        at('2', '2026-02-01'),
        at('3', '2026-02-20'),
        at('4', ''),
      ]),
    ).toEqual([
      { month: '2025-11', count: 1 },
      { month: '2025-12', count: 0 },
      { month: '2026-01', count: 0 },
      { month: '2026-02', count: 2 },
    ]);
    expect(monthlyCounts([])).toEqual([]);
  });
});

describe('timeline playback', () => {
  it('shows what was documented up to the month, highlighting that month', () => {
    const { points } = mapPoints(
      {
        Eventos: [
          { _id: 'E-1', Territorio: 'Vice', Fecha: '2026-08-02' },
          { _id: 'E-2', Territorio: 'Vice', Fecha: '2026-09-20' },
          { _id: 'E-3', Territorio: 'Vice', Fecha: '2026-10-01' },
          { _id: 'E-4', Territorio: 'Vice' },
        ],
        Demandas: [],
        Actores: [],
      },
      'PRJ-SECHURA',
    );
    expect(atCursor(points, '').map((d) => d.emphasis)).toEqual([
      'normal',
      'normal',
      'normal',
      'normal',
    ]);
    expect(atCursor(points, '2026-09').map((d) => [d.point.id, d.emphasis])).toEqual([
      ['E-1', 'dim'],
      ['E-2', 'current'],
    ]);
  });

  it('keeps exact coordinates in place and filters by information state', () => {
    const { points } = mapPoints(
      {
        Eventos: [
          { _id: 'E-1', Latitud: -5.5, Longitud: -80.8, Nivel_Verificacion: 'A', Fuente_ID: 'F' },
          { _id: 'E-2', Latitud: -5.5, Longitud: -80.8 },
        ],
        Demandas: [],
        Actores: [],
      },
      'PRJ-SECHURA',
    );
    expect(points.map((p) => [p.id, p.at, p.precision, p.evidence])).toEqual([
      ['E-1', [-80.8, -5.5], 'exacta', 'observado'],
      ['E-2', [-80.8, -5.5], 'exacta', 'estimado'],
    ]);
    const filters = { layer: '', dimension: '', locality: '', from: '', to: '' };
    expect(filterPoints(points, { ...filters, evidence: ['observado'] }).map((p) => p.id)).toEqual([
      'E-1',
    ]);
  });
});
