import { describe, expect, it } from 'vitest';
import { columnsOf } from './columns.ts';
import type { CanvasPoint } from './types.ts';

const point = (
  id: string,
  at: readonly [number, number],
  evidence: CanvasPoint['evidence'] = 'observado',
  color: readonly [number, number, number] = [10, 20, 30],
): CanvasPoint => ({ id, at, color, evidence, emphasis: 'normal' });

describe('columnsOf', () => {
  it('counts the records of each cell at their mean position', () => {
    const columns = columnsOf([
      point('a', [-80.8201, -5.5601]),
      point('b', [-80.8209, -5.5609], 'estimado'),
      point('c', [-80.7001, -5.4001]),
    ]);
    expect(columns).toHaveLength(2);
    const [first, second] = columns;
    expect(first).toMatchObject({ count: 2, observed: 1 });
    expect(first?.at[0]).toBeCloseTo(-80.8205, 6);
    expect(first?.at[1]).toBeCloseTo(-5.5605, 6);
    expect(second).toMatchObject({ count: 1, observed: 1 });
  });

  it('leaves scenarios out, so a column is only documented records', () => {
    expect(columnsOf([point('s', [-80.82, -5.56], 'escenario')])).toEqual([]);
    const [column] = columnsOf([
      point('a', [-80.8201, -5.5601]),
      point('s', [-80.8202, -5.5602], 'escenario'),
    ]);
    expect(column?.count).toBe(1);
  });

  it('colours a cell by its most frequent dimension, the first one on a tie', () => {
    const red = [200, 0, 0] as const;
    const blue = [0, 0, 200] as const;
    expect(
      columnsOf([
        point('a', [-80.8201, -5.5601], 'observado', red),
        point('b', [-80.8202, -5.5602], 'observado', blue),
        point('c', [-80.8203, -5.5603], 'observado', blue),
      ])[0]?.color,
    ).toEqual(blue);
    expect(
      columnsOf([
        point('a', [-80.8201, -5.5601], 'observado', red),
        point('b', [-80.8202, -5.5602], 'observado', blue),
      ])[0]?.color,
    ).toEqual(red);
  });
});
