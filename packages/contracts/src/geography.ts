import { z } from 'zod';
type Point = readonly [number, number];
const cross = (a: Point, b: Point, c: Point) =>
  (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
const onSegment = (p: Point, a: Point, b: Point) =>
  Math.abs(cross(a, b, p)) < 1e-12 &&
  p[0] >= Math.min(a[0], b[0]) &&
  p[0] <= Math.max(a[0], b[0]) &&
  p[1] >= Math.min(a[1], b[1]) &&
  p[1] <= Math.max(a[1], b[1]);
const meet = (a: Point, b: Point, c: Point, d: Point) =>
  (cross(a, b, c) * cross(a, b, d) < 0 && cross(c, d, a) * cross(c, d, b) < 0) ||
  onSegment(a, c, d) ||
  onSegment(b, c, d) ||
  onSegment(c, a, b) ||
  onSegment(d, a, b);
const contains = (p: Point, r: readonly Point[]) => {
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
const ringsMeet = (a: readonly Point[], b: readonly Point[]) =>
  a.slice(1).some((p, i) =>
    b.slice(1).some((q, j) => {
      const pa = a[i],
        pb = b[j];
      return pa && pb && meet(pa, p, pb, q);
    }),
  );
const Position = z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]);
export const GeographyPolygon = z
  .object({
    type: z.literal('Polygon'),
    coordinates: z.array(z.array(Position).min(4).max(500)).min(1).max(16),
  })
  .strict()
  .superRefine((p, ctx) => {
    const shell = p.coordinates[0];
    for (const [index, hole] of p.coordinates.slice(1).entries()) {
      if (!shell || !hole[0] || !contains(hole[0], shell) || ringsMeet(shell, hole))
        ctx.addIssue({ code: 'custom', message: 'Hueco fuera del exterior' });
      for (const other of p.coordinates.slice(1, index + 1))
        if (
          ringsMeet(other, hole) ||
          (hole[0] && contains(hole[0], other)) ||
          (other[0] && contains(other[0], hole))
        )
          ctx.addIssue({ code: 'custom', message: 'Huecos superpuestos' });
    }
    for (const ring of p.coordinates) {
      for (let i = 1; i < ring.length; i++)
        for (let j = i + 2; j < ring.length; j++) {
          if (i === 1 && j === ring.length - 1) continue;
          const a = ring[i - 1],
            b = ring[i],
            c = ring[j - 1],
            d = ring[j];
          if (a && b && c && d && meet(a, b, c, d))
            ctx.addIssue({ code: 'custom', message: 'Anillo autointersectado' });
        }
      const a = ring[0],
        b = ring.at(-1);
      if (!a || !b) continue;
      if (a[0] !== b[0] || a[1] !== b[1])
        ctx.addIssue({ code: 'custom', message: 'Anillo abierto' });
      const area = ring.slice(1).reduce((sum, c, i) => {
        const prev = ring[i];
        return prev ? sum + prev[0] * c[1] - c[0] * prev[1] : sum;
      }, 0);
      if (Math.abs(area) < 1e-12)
        ctx.addIssue({ code: 'custom', message: 'Anillo sin superficie' });
    }
  });
export type GeographyPolygon = z.infer<typeof GeographyPolygon>;
export const GeographyServiceId = z.enum([
  'SERV_CATASTRO_MINERO',
  'SERV_MAPAS_GEOLOGICOS',
  'SERV_POTENCIALMINERO',
  'SERV_PELIGROS_GEOLOGICOS',
  'SERV_PASIVO_AMBIENTAL',
  'SERV_REINFO',
  'SERV_HIDROGEOLOGIA_PERU',
]);
export const GeographyQuery = z
  .object({
    serviceId: GeographyServiceId.default('SERV_CATASTRO_MINERO'),
    layerId: z.number().int().min(0).max(10000),
    bbox: z
      .tuple([
        z.number().min(-180).max(180),
        z.number().min(-90).max(90),
        z.number().min(-180).max(180),
        z.number().min(-90).max(90),
      ])
      .optional(),
    polygon: GeographyPolygon.optional(),
    concessionCode: z.string().trim().min(1).max(100).optional(),
    /** Area of influence around the polygon, metres (docs/adr/0025). */
    influenceMeters: z.number().int().min(0).max(20_000).optional(),
  })
  .strict()
  .superRefine((q, ctx) => {
    if (Boolean(q.bbox) === Boolean(q.polygon))
      ctx.addIssue({ code: 'custom', message: 'Indique límites o polígono' });
    const pts = q.polygon?.coordinates.flat();
    const b: [number, number, number, number] | null =
      q.bbox ??
      (pts
        ? [
            Math.min(...pts.map((p) => p[0])),
            Math.min(...pts.map((p) => p[1])),
            Math.max(...pts.map((p) => p[0])),
            Math.max(...pts.map((p) => p[1])),
          ]
        : null);
    if (b && (!(b[0] < b[2] && b[1] < b[3]) || b[2] - b[0] > 5 || b[3] - b[1] > 5))
      ctx.addIssue({
        code: 'custom',
        message: 'Área inválida o demasiado extensa (máximo 5° por eje)',
      });
    if ((q.concessionCode || q.influenceMeters) && !q.polygon)
      ctx.addIssue({ code: 'custom', message: 'La relación requiere el polígono de la concesión' });
  });
export type GeographyQuery = z.infer<typeof GeographyQuery>;
export const GeographyLayer = z.object({
  serviceId: GeographyServiceId,
  id: z.number().int(),
  name: z.string(),
  minScale: z.number().nullable(),
  maxScale: z.number().nullable(),
  capabilities: z.string(),
  attribution: z.string(),
  exportUrl: z.string(),
  metadataUrl: z.string(),
});
export const GeographyCatalogue = z.object({
  status: z.enum(['verified', 'unavailable']),
  checkedAt: z.string(),
  serviceUrl: z.string(),
  attribution: z.string(),
  services: z
    .array(
      z.object({
        id: GeographyServiceId,
        status: z.enum(['verified', 'unavailable']),
        checkedAt: z.string(),
        error: z.string().optional(),
      }),
    )
    .default([]),
  layers: z.array(GeographyLayer),
  error: z.string().optional(),
});
export type GeographyCatalogue = z.infer<typeof GeographyCatalogue>;
export const GeographyResult = z.object({
  features: z.array(
    z.object({ attributes: z.record(z.string(), z.unknown()), geometry: z.unknown().optional() }),
  ),
  truncated: z.boolean(),
  source: z.string(),
  related: z.array(
    z.object({
      id: z.string(),
      module: z.string(),
      relationship: z.enum(['geometry', 'explicit-reference', 'proximity']),
      evidence: z.string(),
      /** Metres from the record's coordinates to the polygon; 0 inside. */
      distanceMeters: z.number().nonnegative().optional(),
    }),
  ),
  unlocated: z.array(z.object({ id: z.string(), module: z.string(), reason: z.string() })),
  /** Present when an area of influence was requested: its width and the engine that measured it. */
  influence: z.object({ meters: z.number(), engine: z.enum(['postgis', 'geodesic']) }).optional(),
});
export type GeographyResult = z.infer<typeof GeographyResult>;
