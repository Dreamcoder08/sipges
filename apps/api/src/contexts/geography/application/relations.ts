import { GeographyPolygon, type GeographyResult } from '@mascli/contracts';
import { intersects, pointInPolygon } from '../domain/geometry.ts';
type Point = readonly [number, number];
const coordinate = (v: unknown) =>
  typeof v === 'number'
    ? v
    : typeof v === 'string' && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(v.trim())
      ? Number(v)
      : NaN;
export type GeographyRecords = Readonly<
  Record<
    string,
    readonly { id: string; payload: Readonly<Record<string, unknown>>; marking?: string }[]
  >
>;
/** Names alone never establish geometry. References require code and documented source. */
export const relateRecords = (
  records: GeographyRecords,
  polygon: GeographyPolygon,
  code?: string,
) => {
  const related: GeographyResult['related'] = [],
    unlocated: GeographyResult['unlocated'] = [];
  for (const [module, items] of Object.entries(records))
    for (const record of items) {
      const p = record.payload,
        raw = p['geometry'] ?? p['Geometria'];
      const parsed = GeographyPolygon.safeParse(raw);
      const lon = coordinate(p['Longitud']),
        lat = coordinate(p['Latitud']);
      const point: Point | null =
        Number.isFinite(lon) && Number.isFinite(lat) && Math.abs(lon) <= 180 && Math.abs(lat) <= 90
          ? [lon, lat]
          : null;
      const isPoint =
        raw &&
        typeof raw === 'object' &&
        'type' in raw &&
        raw.type === 'Point' &&
        'coordinates' in raw &&
        Array.isArray(raw.coordinates) &&
        raw.coordinates.length === 2 &&
        raw.coordinates.every((v) => typeof v === 'number' && Number.isFinite(v)) &&
        Math.abs(raw.coordinates[0] as number) <= 180 &&
        Math.abs(raw.coordinates[1] as number) <= 90
          ? ([raw.coordinates[0] as number, raw.coordinates[1] as number] as const)
          : null;
      const locatedPoint = point ?? isPoint;
      const located = parsed.success || locatedPoint !== null;
      if (
        parsed.success
          ? intersects(parsed.data, polygon)
          : locatedPoint
            ? pointInPolygon(locatedPoint, polygon)
            : false
      )
        related.push({
          id: record.id,
          module,
          relationship: 'geometry',
          evidence: parsed.success ? 'GeoJSON Polygon WGS84' : 'Coordenadas explícitas WGS84',
        });
      else if (
        code &&
        p['Concesion_Codigo'] === code &&
        typeof p['Concesion_Fuente'] === 'string' &&
        p['Concesion_Fuente'].trim()
      )
        related.push({
          id: record.id,
          module,
          relationship: 'explicit-reference',
          evidence: p['Concesion_Fuente'].slice(0, 1000),
        });
      if (!located)
        unlocated.push({
          id: record.id,
          module,
          reason: 'Sin geometría WGS84 válida; Territorio no se geocodifica',
        });
    }
  return { related, unlocated };
};
