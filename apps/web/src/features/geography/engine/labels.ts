import type { CanvasPoint } from './types.ts';

/** Font size, in pixels, of a list number drawn over its marker. */
export const labelSize = (label: string) => (label.length > 2 ? 10 : 12);

/** Web Mercator pixels at `zoom` (512 px world, as MapLibre and deck.gl draw it). */
const pixel = ([lon, lat]: CanvasPoint['at'], zoom: number) => {
  const world = 512 * 2 ** zoom;
  const sin = Math.sin((lat * Math.PI) / 180);
  return [
    ((lon + 180) / 360) * world,
    (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * world,
  ] as const;
};

/**
 * Ids of the points whose list number is drawn at `zoom`. Records of one locality sit a few
 * pixels apart at the zoom a phone fits them to, and their numbers would print over each other
 * ("17" + "16" read as "1716"). A number is drawn only where its box (with margin over the
 * 0.6 em monospace digits and their halo) clears the numbers already placed: the selected
 * record first, then the timeline's current month, then list order. A hidden number keeps its
 * marker, which stays selectable on the map and from the list.
 */
export const placeLabels = (
  points: readonly CanvasPoint[],
  zoom: number,
  selected = '',
): ReadonlySet<string> => {
  const rank = (p: CanvasPoint) => (p.id === selected ? 0 : p.emphasis === 'current' ? 1 : 2);
  const order = points.filter((p) => p.label).sort((a, b) => rank(a) - rank(b));
  const placed: { x: number; y: number; w: number; h: number }[] = [];
  const drawn = new Set<string>();
  for (const p of order) {
    const label = p.label ?? '';
    const size = labelSize(label);
    const [x, y] = pixel(p.at, zoom);
    const box = { x, y, w: label.length * size * 0.7 + 6, h: size + 4 };
    const clear = placed.every(
      (o) => Math.abs(o.x - x) * 2 >= o.w + box.w || Math.abs(o.y - y) * 2 >= o.h + box.h,
    );
    if (!clear) continue;
    placed.push(box);
    drawn.add(p.id);
  }
  return drawn;
};
