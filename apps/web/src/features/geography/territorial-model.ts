import {
  type DimensionCode,
  type Level,
  dimensionOf,
  foldText,
  severityLevel,
} from '../../shared/lib/text.ts';
import { monthlySeries } from '../../shared/ui/time/series.ts';
import { type Evidence, evidenceOf } from './evidence.ts';
import { localityOf } from './localities.ts';
import type { LonLat } from './sechura-base.ts';

export type TerritorialRecord = Readonly<Record<string, unknown>> & { readonly _id: string };

export const LAYERS = ['Eventos', 'Demandas', 'Actores'] as const;
export type Layer = (typeof LAYERS)[number];
export const LAYER_SLUGS: Readonly<Record<Layer, string>> = {
  Eventos: 'eventos',
  Demandas: 'demandas',
  Actores: 'actores',
};

export type MapPoint = {
  readonly id: string;
  readonly layer: Layer;
  readonly dimension: DimensionCode;
  readonly title: string;
  readonly date: string;
  readonly territory: string;
  readonly locality: string;
  readonly at: LonLat;
  readonly level: Level;
  readonly actor: string;
  readonly status: string;
  readonly evidence: Evidence;
  /** Why `evidence` was assigned, shown with the record so the state stays traceable. */
  readonly evidenceBasis: string;
  readonly source: string;
  readonly verification: string;
  /** Exact WGS84 coordinates in the record, or the approximate centre of its locality. */
  readonly precision: 'exacta' | 'localidad';
};

const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
const number = (value: unknown) => {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(text(value));
  return Number.isFinite(parsed) ? parsed : null;
};

/**
 * Explicit coordinates win; otherwise the Sechura locality named in `Territorio`, only for
 * projects in that province (`sechura`). Elsewhere the locality is what the record carries.
 */
const placeOf = (
  record: TerritorialRecord,
  sechura: boolean,
): { at: LonLat; locality: string; exact: boolean } | null => {
  const lon = number(record['Longitud']);
  const lat = number(record['Latitud']);
  const locality = sechura ? localityOf(record['Territorio']) : null;
  if (lon !== null && lat !== null && Math.abs(lon) <= 180 && Math.abs(lat) <= 90)
    return { at: [lon, lat], locality: locality?.name ?? text(record['Territorio']), exact: true };
  return locality ? { at: locality.at, locality: locality.name, exact: false } : null;
};

const DESCRIPTORS: Record<
  Layer,
  { dimension: (r: TerritorialRecord) => DimensionCode; title: string[]; date: string[] }
> = {
  Eventos: {
    dimension: (r) => dimensionOf(r['Dimension_Principal']) ?? 'E',
    title: ['Descripcion_Hecho', 'Tipo_Evento'],
    date: ['Fecha'],
  },
  Demandas: { dimension: () => 'D', title: ['Descripcion', 'Tema'], date: ['Fecha_Registro'] },
  Actores: {
    dimension: () => 'A',
    title: ['Nombre_Actor/Organizacion', 'Tipo_Actor'],
    date: ['Fecha_Registro', 'Fecha'],
  },
};

const evidence = (record: TerritorialRecord) => {
  const { state, basis } = evidenceOf(record);
  return { evidence: state, evidenceBasis: basis };
};

const first = (record: TerritorialRecord, keys: readonly string[]) =>
  keys.map((key) => text(record[key])).find(Boolean) ?? '';

/**
 * Located records of the active project as map points. Records at the same place are spread
 * on a small spiral (golden angle) so each one stays visible and clickable.
 */
export const mapPoints = (
  layers: Readonly<Record<Layer, readonly TerritorialRecord[]>>,
  projectId: string,
  /** Whether the project lies in the Sechura province, whose localities place records. */
  sechura = true,
) => {
  const points: MapPoint[] = [];
  let unlocated = 0;
  const seen = new Map<string, number>();
  for (const layer of LAYERS) {
    const describe = DESCRIPTORS[layer];
    for (const record of layers[layer]) {
      const owner = text(record['Proyecto_ID']) || 'PRJ-SECHURA';
      if (owner !== projectId) continue;
      const place = placeOf(record, sechura);
      if (!place) {
        unlocated += 1;
        continue;
      }
      const key = place.at.join(',');
      const index = seen.get(key) ?? 0;
      seen.set(key, index + 1);
      const radius = index && !place.exact ? 0.006 * Math.sqrt(index) : 0;
      const angle = index * 2.39996;
      points.push({
        id: record._id,
        layer,
        dimension: describe.dimension(record),
        title: first(record, describe.title) || record._id,
        date: first(record, describe.date),
        territory: text(record['Territorio']),
        locality: place.locality,
        at: [place.at[0] + Math.cos(angle) * radius, place.at[1] + Math.sin(angle) * radius],
        level: severityLevel(record['Prioridad'] || record['Nivel'] || record['Influencia']),
        actor: text(record['Actor_Principal']) || text(record['Actor/Grupo']),
        status: text(record['Estado']) || text(record['Estado_Validacion']),
        ...evidence(record),
        source: text(record['Fuente_ID']),
        verification: text(record['Nivel_Verificacion']),
        precision: place.exact ? 'exacta' : 'localidad',
      });
    }
  }
  return { points, unlocated };
};

export type MapFilters = {
  layer: string;
  dimension: string;
  locality: string;
  /** Inclusive month range (YYYY-MM); empty means open-ended. */
  from: string;
  to: string;
  /** Information states shown; empty means all. */
  evidence?: readonly Evidence[];
};

export const monthOf = (point: MapPoint) => {
  const month = point.date.slice(0, 7);
  return /^\d{4}-\d{2}$/.test(month) ? month : '';
};

/** Points matching the toolbar filters except time; an empty filter value means "all". */
export const filterPlace = (points: readonly MapPoint[], filters: MapFilters) =>
  points.filter(
    (p) =>
      (!filters.layer || p.layer === filters.layer) &&
      (!filters.dimension || p.dimension === filters.dimension) &&
      (!filters.locality || foldText(p.locality) === foldText(filters.locality)) &&
      (!filters.evidence?.length || filters.evidence.includes(p.evidence)),
  );

/** Undated points are shown only while no time range is set. */
export const inPeriod = (point: MapPoint, from: string, to: string) => {
  if (!from && !to) return true;
  const month = monthOf(point);
  return Boolean(month) && (!from || month >= from) && (!to || month <= to);
};

export const filterPoints = (points: readonly MapPoint[], filters: MapFilters) =>
  filterPlace(points, filters).filter((p) => inPeriod(p, filters.from, filters.to));

/** Months (YYYY-MM) present in the points, newest first. */
export const monthsOf = (points: readonly MapPoint[]) =>
  [...new Set(points.map(monthOf).filter(Boolean))].sort().reverse();

/** Points per month over the continuous span of dated points (oldest first). */
export const monthlyCounts = (points: readonly MapPoint[]) =>
  monthlySeries(points.map((p) => p.date));

/**
 * Timeline playback: what was documented up to `cursor` (YYYY-MM), the month itself current
 * and the earlier ones dimmed. Without a cursor every point stays as it is; undated points
 * are left out of playback, since they cannot be placed in time.
 */
export type Emphasis = 'current' | 'normal' | 'dim';
export const atCursor = (
  points: readonly MapPoint[],
  cursor: string,
): { point: MapPoint; emphasis: Emphasis }[] =>
  points.flatMap((point): { point: MapPoint; emphasis: Emphasis }[] => {
    if (!cursor) return [{ point, emphasis: 'normal' }];
    const month = monthOf(point);
    if (!month || month > cursor) return [];
    return [{ point, emphasis: month === cursor ? 'current' : 'dim' }];
  });
