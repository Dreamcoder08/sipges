import { describe, expect, it } from 'vitest';
import { layoutGraph } from './layout.ts';

const nodes = ['r', 'a', 'b', 'c', 'd'].map((id) => ({ id, label: id, group: 'g' }));
const edges = [
  { source: 'r', target: 'a', label: 'x' },
  { source: 'r', target: 'b', label: 'x' },
  { source: 'a', target: 'c', label: 'x' },
  { source: 'zz', target: 'd', label: 'ignored' },
];

describe('layoutGraph', () => {
  it('is deterministic, pins the root and keeps nodes inside the box', () => {
    const one = layoutGraph(nodes, edges, { width: 400, height: 300, root: 'r' });
    const two = layoutGraph(nodes, edges, { width: 400, height: 300, root: 'r' });
    expect([...one]).toEqual([...two]);
    expect(one.get('r')).toEqual({ x: 200, y: 150 });
    for (const point of one.values()) {
      expect(point.x).toBeGreaterThanOrEqual(30);
      expect(point.x).toBeLessThanOrEqual(370);
      expect(point.y).toBeGreaterThanOrEqual(30);
      expect(point.y).toBeLessThanOrEqual(270);
    }
  });

  it('keeps linked nodes closer than unlinked ones', () => {
    const p = layoutGraph(nodes, edges, { width: 600, height: 600, root: 'r' });
    const distance = (a: string, b: string) => {
      const pa = p.get(a);
      const pb = p.get(b);
      return pa && pb ? Math.hypot(pa.x - pb.x, pa.y - pb.y) : Number.NaN;
    };
    expect(distance('a', 'c')).toBeLessThan(distance('c', 'd'));
  });

  it('handles empty and single-node graphs', () => {
    expect(layoutGraph([], [], { width: 10, height: 10 }).size).toBe(0);
    expect([
      ...layoutGraph([nodes[0] ?? { id: 'r', label: 'r', group: 'g' }], [], {
        width: 10,
        height: 10,
      }).keys(),
    ]).toEqual(['r']);
  });
});
