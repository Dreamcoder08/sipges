import type { ProjectCoordinates } from '@sipges/contracts';
import type { Extent } from './BaseMap.tsx';

type Concession = ProjectCoordinates['concessions'][number];

/** Why a polygon cannot be drawn as stored; each reason is shown to the reader. */
export type GeometryProblem =
  | 'coordenadas no numéricas'
  | 'fuera de WGS 84'
  | 'anillo abierto'
  | 'anillo sin superficie'
  | 'sin anillos';

const ringProblem = (ring: readonly (readonly number[])[]): GeometryProblem | null => {
  if (ring.some((point) => point.length < 2 || !point.every(Number.isFinite)))
    return 'coordenadas no numéricas';
  if (ring.some(([lon = 0, lat = 0]) => Math.abs(lon) > 180 || Math.abs(lat) > 90))
    return 'fuera de WGS 84';
  const [first, last] = [ring[0], ring.at(-1)];
  if (!first || !last || first[0] !== last[0] || first[1] !== last[1]) return 'anillo abierto';
  // Subtract the first vertex before computing area to avoid cancellation in lon/lat.
  const [originX = 0, originY = 0] = first;
  const area = ring.slice(1).reduce((sum, [x = 0, y = 0], index) => {
    const [px = 0, py = 0] = ring[index] ?? [];
    return sum + (px - originX) * (y - originY) - (x - originX) * (py - originY);
  }, 0);
  if (ring.length < 4 || area === 0) return 'anillo sin superficie';
  return null;
};

/**
 * Splits concessions into drawable polygons (EPSG:4326, [lon, lat], closed rings) and the ones
 * that cannot be drawn, so a bad geometry is reported instead of rendering a misleading map.
 */
export const checkConcessions = (concessions: readonly Concession[]) => {
  const valid: Concession[] = [];
  const invalid: { code: string; name: string; problem: GeometryProblem }[] = [];
  for (const concession of concessions) {
    const problem = concession.geometry.coordinates.length
      ? (concession.geometry.coordinates.map(ringProblem).find(Boolean) ?? null)
      : 'sin anillos';
    if (problem) invalid.push({ code: concession.code, name: concession.name, problem });
    else valid.push(concession);
  }
  return { valid, invalid };
};

/** Bounds of a polygon's rings: [minLon, minLat, maxLon, maxLat]. */
export const ringsExtent = (rings: readonly (readonly (readonly number[])[])[]): Extent => {
  const points = rings.flat();
  const lons = points.map(([lon = 0]) => lon);
  const lats = points.map(([, lat = 0]) => lat);
  return [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)];
};
