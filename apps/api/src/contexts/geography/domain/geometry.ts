export type GeographyPolygon = { type: 'Polygon'; coordinates: [number, number][][] };
type Point = readonly [number, number];
const cross = (a: Point, b: Point, c: Point) =>
  (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
const onSegment = (p: Point, a: Point, b: Point) =>
  Math.abs(cross(a, b, p)) < 1e-10 &&
  p[0] >= Math.min(a[0], b[0]) - 1e-10 &&
  p[0] <= Math.max(a[0], b[0]) + 1e-10 &&
  p[1] >= Math.min(a[1], b[1]) - 1e-10 &&
  p[1] <= Math.max(a[1], b[1]) + 1e-10;
const ringContains = (p: Point, r: readonly Point[]) => {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const a = r[i],
      b = r[j];
    if (
      a &&
      b &&
      a[1] > p[1] !== b[1] > p[1] &&
      p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]
    )
      inside = !inside;
  }
  return inside;
};
export const pointInPolygon = (p: Point, polygon: GeographyPolygon) => {
  const rings = polygon.coordinates;
  if (rings.some((r) => r.slice(1).some((b, i) => (r[i] ? onSegment(p, r[i], b) : false))))
    return true;
  return (
    Boolean(rings[0] && ringContains(p, rings[0])) &&
    !rings.slice(1).some((r) => ringContains(p, r))
  );
};
export const intersects = (a: GeographyPolygon, b: GeographyPolygon) => {
  if (
    a.coordinates.flat().some((p) => pointInPolygon(p, b)) ||
    b.coordinates.flat().some((p) => pointInPolygon(p, a))
  )
    return true;
  for (const r of a.coordinates)
    for (const s of b.coordinates)
      for (let i = 1; i < r.length; i++)
        for (let j = 1; j < s.length; j++) {
          const p = r[i - 1],
            q = r[i],
            u = s[j - 1],
            v = s[j];
          if (
            p &&
            q &&
            u &&
            v &&
            cross(p, q, u) * cross(p, q, v) < 0 &&
            cross(u, v, p) * cross(u, v, q) < 0
          )
            return true;
        }
  return false;
};
