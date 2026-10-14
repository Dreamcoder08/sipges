import { describe, expect, it } from 'vitest';
import { localityOf } from './localities.ts';
import { filterPoints, mapPoints, monthsOf } from './territorial-model.ts';

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
    expect(
      filterPoints(points, { layer: 'Eventos', dimension: '', locality: 'vice', month: '2026-10' }),
    ).toHaveLength(1);
  });
});
