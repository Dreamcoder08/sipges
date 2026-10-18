import { GeographyPolygon, type GeographyResult } from '@mascli/contracts';
import type { Extent } from './BaseMap.tsx';

export { LEGEND, legendOf } from './legend.ts';

type Position = [number, number];
type Ring = Position[];

export type Concession = {
  readonly code: string;
  readonly name: string;
  readonly holder: string;
  readonly hectares: number | null;
  readonly status: string;
  readonly legend: string;
  readonly formulatedAt: string;
  readonly updatedAt: string;
  readonly place: string;
  readonly geometry:
    { type: 'Polygon'; coordinates: Ring[] } | { type: 'MultiPolygon'; coordinates: Ring[][] };
  readonly extent: Extent;
  /** The official attributes exactly as INGEMMET returned them. */
  readonly attributes: Readonly<Record<string, unknown>>;
};

const text = (value: unknown) =>
  typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : '';

const DAY = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Lima',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
/** ArcGIS dates are epoch milliseconds; INGEMMET publishes them in Peru's time zone. */
export const esriDate = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) ? DAY.format(new Date(value)) : '';

const signedArea = (ring: readonly Position[]) =>
  ring.slice(1).reduce((sum, [x, y], i) => {
    const prev = ring[i];
    return prev ? sum + (prev[0] * y - x * prev[1]) / 2 : sum;
  }, 0);

const inside = ([x, y]: Position, ring: readonly Position[]) => {
  let result = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if (a && b && a[1] > y !== b[1] > y && x < ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0])
      result = !result;
  }
  return result;
};

const isPosition = (value: unknown): value is Position =>
  Array.isArray(value) &&
  value.length >= 2 &&
  typeof value[0] === 'number' &&
  typeof value[1] === 'number' &&
  Math.abs(value[0]) <= 180 &&
  Math.abs(value[1]) <= 90;

/**
 * Esri rings to GeoJSON polygons: clockwise rings are exteriors, the others holes of the
 * exterior that contains them (ArcGIS REST geometry objects). Without any clockwise ring every
 * ring is taken as an exterior, so nothing official is dropped silently.
 */
export const esriRingsToGeoJson = (geometry: unknown): Concession['geometry'] | null => {
  const raw = (geometry as { rings?: unknown } | null)?.rings;
  if (!Array.isArray(raw)) return null;
  const rings = raw
    .filter((ring): ring is unknown[] => Array.isArray(ring))
    .map((ring) => ring.filter(isPosition).map(([x, y]) => [x, y] as Position))
    .filter((ring) => ring.length >= 4);
  if (!rings.length) return null;
  const clockwise = rings.filter((ring) => signedArea(ring) < 0);
  const shells = clockwise.length ? clockwise : rings;
  const polygons = shells.map((shell) => [[...shell].reverse()]);
  for (const ring of clockwise.length ? rings.filter((r) => signedArea(r) >= 0) : []) {
    const owner = shells.findIndex((shell) => ring[0] && inside(ring[0], shell));
    if (owner >= 0) polygons[owner]?.push([...ring].reverse());
  }
  return polygons.length === 1 && polygons[0]
    ? { type: 'Polygon', coordinates: polygons[0] }
    : { type: 'MultiPolygon', coordinates: polygons };
};

const extentOf = (geometry: Concession['geometry']): Extent => {
  const points = (
    geometry.type === 'Polygon' ? geometry.coordinates : geometry.coordinates.flat()
  ).flat();
  return [
    Math.min(...points.map((p) => p[0])),
    Math.min(...points.map((p) => p[1])),
    Math.max(...points.map((p) => p[0])),
    Math.max(...points.map((p) => p[1])),
  ];
};

/** Official features with a drawable geometry, keyed by their unique code (CODIGOU). */
export const concessionsOf = (features: GeographyResult['features']): Concession[] => {
  const seen = new Set<string>();
  const result: Concession[] = [];
  for (const feature of features) {
    const a = feature.attributes;
    const code = text(a['CODIGOU']);
    const geometry = esriRingsToGeoJson(feature.geometry);
    if (!code || !geometry || seen.has(code)) continue;
    seen.add(code);
    const hectares = typeof a['HECTAGIS'] === 'number' ? a['HECTAGIS'] : null;
    result.push({
      code,
      name: text(a['CONCESION']) || code,
      holder: text(a['TIT_CONCES']),
      hectares,
      status: text(a['D_ESTADO']) || text(a['ESTADO']),
      legend: text(a['LEYENDA']),
      formulatedAt: esriDate(a['FEC_DENU']),
      updatedAt: esriDate(a['FECHA_ACTUALIZACION']),
      place: [a['DISTRI'], a['PROVI'], a['DEPA']].map(text).filter(Boolean).join(', '),
      geometry,
      extent: extentOf(geometry),
      attributes: a,
    });
  }
  return result;
};

/**
 * The polygon sent to relate MASCLI records: the largest part of the concession, as long as it
 * fits the API contract (500 vertices per ring, 16 rings). Larger shapes are not simplified,
 * since a simplified boundary would relate records the official one does not contain.
 */
export const relationPolygon = (concession: Concession): GeographyPolygon | null => {
  const parts =
    concession.geometry.type === 'Polygon'
      ? [concession.geometry.coordinates]
      : concession.geometry.coordinates;
  const largest = [...parts].sort(
    (a, b) => Math.abs(signedArea(b[0] ?? [])) - Math.abs(signedArea(a[0] ?? [])),
  )[0];
  const parsed = GeographyPolygon.safeParse({ type: 'Polygon', coordinates: largest });
  return parsed.success ? parsed.data : null;
};

/** Clamps a view to the API's query limits (5° per axis) around its centre. */
export const queryExtent = ([minLon, minLat, maxLon, maxLat]: Extent): Extent => {
  const half = 2.45;
  const lon = (minLon + maxLon) / 2;
  const lat = (minLat + maxLat) / 2;
  const dLon = Math.min((maxLon - minLon) / 2, half);
  const dLat = Math.min((maxLat - minLat) / 2, half);
  return [
    Math.max(-180, lon - dLon),
    Math.max(-90, lat - dLat),
    Math.min(180, lon + dLon),
    Math.min(90, lat + dLat),
  ];
};
