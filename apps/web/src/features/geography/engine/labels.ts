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

/** A number's box, centred on its marker, in the units of the map that draws it. */
export type LabelBox = {
  readonly id: string;
  readonly emphasis: CanvasPoint['emphasis'];
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
};

/**
 * Ids of the boxes whose number is drawn: one is drawn only where it clears the numbers already
 * placed, the selected record first, then the timeline's current month, then the given (list)
 * order. Both renderers use it, the WebGL engine in Web Mercator pixels (`placeLabels`) and the
 * SVG map in its own units, so a group of close markers shows one readable number each.
 */
export const clearLabels = (boxes: readonly LabelBox[], selected = ''): ReadonlySet<string> => {
  const rank = (b: LabelBox) => (b.id === selected ? 0 : b.emphasis === 'current' ? 1 : 2);
  const placed: LabelBox[] = [];
  const drawn = new Set<string>();
  for (const box of [...boxes].sort((a, b) => rank(a) - rank(b))) {
    const clear = placed.every(
      (o) => Math.abs(o.x - box.x) * 2 >= o.w + box.w || Math.abs(o.y - box.y) * 2 >= o.h + box.h,
    );
    if (!clear) continue;
    placed.push(box);
    drawn.add(box.id);
  }
  return drawn;
};

/**
 * Ids of the points whose list number is drawn at `zoom`. Records of one locality sit a few
 * pixels apart at the zoom a phone fits them to, and their numbers would print over each other
 * ("17" + "16" read as "1716"). A number is drawn only where its box (with margin over the
 * 0.6 em monospace digits and their halo) clears the numbers already placed (`clearLabels`).
 * A hidden number keeps its marker, which stays selectable on the map and from the list.
 */
export const placeLabels = (
  points: readonly CanvasPoint[],
  zoom: number,
  selected = '',
): ReadonlySet<string> =>
  clearLabels(
    points
      .filter((p) => p.label)
      .map((p) => {
        const label = p.label ?? '';
        const size = labelSize(label);
        const [x, y] = pixel(p.at, zoom);
        return {
          id: p.id,
          emphasis: p.emphasis,
          x,
          y,
          w: label.length * size * 0.7 + 6,
          h: size + 4,
        };
      }),
    selected,
  );
