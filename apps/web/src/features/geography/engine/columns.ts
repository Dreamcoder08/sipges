import type { LonLat } from '../sechura-base.ts';
import type { CanvasPoint } from './types.ts';

/** Side of a column cell in degrees (about 1.1 km in Sechura). */
export const CELL_DEGREES = 0.01;
/** Column height per record on screen: a count drawn as height, not a distance. */
export const PIXELS_PER_RECORD = 8;

/**
 * Metres that one record rises at this zoom and latitude, so columns keep a readable height
 * whether the view shows the province or one concession.
 */
export const metresPerRecord = (zoom: number, latitude: number) =>
  (PIXELS_PER_RECORD * 156_543.03 * Math.cos((latitude * Math.PI) / 180)) / 2 ** zoom;

/** Records of one cell of the 3D view, drawn as a column whose height is their count. */
export type CanvasColumn = {
  readonly key: string;
  /** Mean position of the records in the cell. */
  readonly at: LonLat;
  readonly count: number;
  /** Records with explicit coordinates; the rest are placed at their locality. */
  readonly observed: number;
  /** Colour of the dimension with most records in the cell (first seen on a tie). */
  readonly color: readonly [number, number, number];
};

/**
 * Groups the drawn records into cells for the 3D view (ODD territorial-3d T1). Only what was
 * documented counts: scenario records are left out, so a column is never a projection. The
 * height is the number of records, never a forecast or a spread.
 */
export const columnsOf = (
  points: readonly CanvasPoint[],
  cell: number = CELL_DEGREES,
): CanvasColumn[] => {
  const cells = new Map<
    string,
    { lon: number; lat: number; count: number; observed: number; colors: Map<string, number> }
  >();
  for (const p of points) {
    if (p.evidence === 'escenario') continue;
    const key = `${Math.floor(p.at[0] / cell)}:${Math.floor(p.at[1] / cell)}`;
    const entry = cells.get(key) ?? {
      lon: 0,
      lat: 0,
      count: 0,
      observed: 0,
      colors: new Map<string, number>(),
    };
    entry.lon += p.at[0];
    entry.lat += p.at[1];
    entry.count += 1;
    if (p.evidence === 'observado') entry.observed += 1;
    const color = p.color.join(',');
    entry.colors.set(color, (entry.colors.get(color) ?? 0) + 1);
    cells.set(key, entry);
  }
  return [...cells].map(([key, e]) => {
    let best = '';
    let most = 0;
    for (const [color, n] of e.colors)
      if (n > most) {
        best = color;
        most = n;
      }
    return {
      key,
      at: [e.lon / e.count, e.lat / e.count] as const,
      count: e.count,
      observed: e.observed,
      color: best.split(',').map(Number) as unknown as readonly [number, number, number],
    };
  });
};
