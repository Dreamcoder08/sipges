import { describe, expect, it } from 'vitest';
import { labelSize, placeLabels } from './labels.ts';
import type { CanvasPoint } from './types.ts';

const point = (n: number, at: readonly [number, number]): CanvasPoint => ({
  id: `r${n}`,
  label: String(n),
  at,
  color: [10, 20, 30],
  evidence: 'observado',
  emphasis: 'normal',
});

/** Records of one locality on the golden-angle spiral `mapPoints` uses (0.006° · √i). */
const spiral = (count: number, from = 1, centre: readonly [number, number] = [-80.82, -5.56]) =>
  Array.from({ length: count }, (_, i) => {
    const radius = 0.006 * Math.sqrt(i);
    const angle = i * 2.39996;
    return point(from + i, [
      centre[0] + Math.cos(angle) * radius,
      centre[1] + Math.sin(angle) * radius,
    ]);
  });

/** Web Mercator pixels at `zoom` (512 px world, as MapLibre and deck.gl draw it). */
const pixel = ([lon, lat]: readonly [number, number], zoom: number) => {
  const world = 512 * 2 ** zoom;
  const sin = Math.sin((lat * Math.PI) / 180);
  return [
    ((lon + 180) / 360) * world,
    (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * world,
  ] as const;
};

/** The drawn glyphs: monospace digits (0.6 em) with their halo, centred on the point. */
const glyphs = (p: CanvasPoint, zoom: number) => {
  const label = p.label ?? '';
  const size = labelSize(label);
  const [x, y] = pixel(p.at, zoom);
  const w = label.length * size * 0.6 + 2;
  const h = size;
  return { left: x - w / 2, right: x + w / 2, top: y - h / 2, bottom: y + h / 2 };
};

const overlapping = (points: readonly CanvasPoint[], drawn: ReadonlySet<string>, zoom: number) => {
  const shown = points
    .filter((p) => drawn.has(p.id))
    .map((p) => ({ label: p.label, box: glyphs(p, zoom) }));
  const pairs: string[] = [];
  shown.forEach((a, i) =>
    shown.slice(i + 1).forEach((b) => {
      const apart =
        a.box.right <= b.box.left ||
        b.box.right <= a.box.left ||
        a.box.bottom <= b.box.top ||
        b.box.bottom <= a.box.top;
      if (!apart) pairs.push(`${a.label}+${b.label}`);
    }),
  );
  return pairs;
};

/** About the zoom MapLibre fits Sechura's records to on a 360 px phone. */
const PHONE_ZOOM = 9;

describe('placeLabels', () => {
  it('never draws two list numbers over each other at phone zoom', () => {
    const points = [...spiral(12), ...spiral(9, 13, [-80.9, -5.7])];
    const drawn = placeLabels(points, PHONE_ZOOM);
    expect(overlapping(points, drawn, PHONE_ZOOM)).toEqual([]);
    // Each locality still shows a number: the lowest one, first in the list.
    expect(drawn.has('r1')).toBe(true);
    expect(drawn.has('r13')).toBe(true);
  });

  it('draws the selected record’s number even where a lower number collides', () => {
    const points = spiral(12);
    const drawn = placeLabels(points, PHONE_ZOOM, 'r7');
    expect(drawn.has('r7')).toBe(true);
    expect(overlapping(points, drawn, PHONE_ZOOM)).toEqual([]);
  });

  it('keeps every number once the markers are far enough apart', () => {
    const points = spiral(12);
    expect(placeLabels(points, 16).size).toBe(12);
    const scattered = [point(1, [-80.82, -5.56]), point(2, [-80.7, -5.4])];
    expect(placeLabels(scattered, PHONE_ZOOM)).toEqual(new Set(['r1', 'r2']));
  });

  it('leaves out points that carry no number', () => {
    const bare: CanvasPoint = {
      id: 'r1',
      at: [-80.82, -5.56],
      color: [10, 20, 30],
      evidence: 'observado',
      emphasis: 'normal',
    };
    expect(placeLabels([bare, point(2, [-80.7, -5.4])], PHONE_ZOOM)).toEqual(new Set(['r2']));
  });
});
