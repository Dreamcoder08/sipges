import { describe, expect, it } from 'vitest';
import coordinates from '../../../../../data/project_coordinates.json';
import { checkConcessions, ringsExtent } from './geometry.ts';

type Concession = Parameters<typeof checkConcessions>[0][number];
const base = coordinates.concessions[0] as Concession;
const withRing = (ring: number[][]): Concession => ({
  ...base,
  code: 'X',
  geometry: { type: 'Polygon', coordinates: [ring as [number, number][]] },
});

// Regression (functional audit, error 06): invalid geometry is reported, never drawn.
describe('checkConcessions', () => {
  it('accepts every concession of the reference file', () => {
    const { valid, invalid } = checkConcessions(coordinates.concessions as Concession[]);
    expect(invalid).toEqual([]);
    expect(valid).toHaveLength(5);
  });

  it('reports open rings, swapped or out-of-range axes and non-numeric points', () => {
    const square = [
      [-80.7, -5.7],
      [-80.6, -5.7],
      [-80.6, -5.6],
      [-80.7, -5.6],
    ];
    const { valid, invalid } = checkConcessions([
      withRing(square),
      withRing([...square, [-80.7, -5.7]].map(([lon, lat]) => [lat ?? 0, (lon ?? 0) * 3])),
      withRing([...square, [Number.NaN, -5.7]]),
    ]);
    expect(valid).toEqual([]);
    expect(invalid.map((item) => item.problem)).toEqual([
      'anillo abierto',
      'fuera de WGS 84',
      'coordenadas no numéricas',
    ]);
  });

  it('frames one polygon by its own extent', () => {
    expect(
      ringsExtent([
        [
          [-80.7, -5.7],
          [-80.6, -5.6],
        ],
      ]),
    ).toEqual([-80.7, -5.7, -80.6, -5.6]);
  });
});
