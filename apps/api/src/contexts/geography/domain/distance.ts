import { type GeographyPolygon, pointInPolygon } from './geometry.ts';

type Point = readonly [number, number];

/** Mean Earth radius (IUGG), metres. */
const EARTH_RADIUS = 6_371_008.8;
const RAD = Math.PI / 180;

/**
 * Shortest distance in metres from a WGS84 point to a polygon's boundary, 0 when the point is
 * inside. Vertices are projected on a plane tangent at the point (equirectangular), which
 * stays within a few metres of the geodesic distance over the 20 km an area of influence
 * spans. PostGIS replaces it where the extension is installed (docs/adr/0025).
 */
export const distanceToPolygon = (point: Point, polygon: GeographyPolygon) => {
  if (pointInPolygon(point, polygon)) return 0;
  const [lon0, lat0] = point;
  const scale = Math.cos(lat0 * RAD);
  const project = ([lon, lat]: Point): Point => [
    (lon - lon0) * scale * RAD * EARTH_RADIUS,
    (lat - lat0) * RAD * EARTH_RADIUS,
  ];
  let best = Infinity;
  for (const ring of polygon.coordinates)
    for (let i = 1; i < ring.length; i++) {
      const a = ring[i - 1],
        b = ring[i];
      if (!a || !b) continue;
      const [ax, ay] = project(a),
        [bx, by] = project(b);
      const dx = bx - ax,
        dy = by - ay;
      const length = dx * dx + dy * dy;
      const t = length ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / length)) : 0;
      best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
    }
  return best;
};
