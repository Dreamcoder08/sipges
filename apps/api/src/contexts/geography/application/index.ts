import {
  GeographyQuery,
  type GeographyCatalogue,
  type GeographyPolygon,
  type GeographyResult,
} from '@sipges/contracts';
import type { Scope } from '../../tenancy/application/index.ts';
import { relateRecords, type GeographyRecords } from './relations.ts';
export type GeographyGateway = {
  catalogue(): Promise<GeographyCatalogue>;
  query(input: GeographyQuery): Promise<Pick<GeographyResult, 'features' | 'truncated' | 'source'>>;
};
export type SpatialPoint = { readonly key: string; readonly at: readonly [number, number] };

/** Distances from points to a polygon (docs/adr/0025): PostGIS, or a geodesic approximation. */
export type SpatialEngine = {
  distances(
    polygon: GeographyPolygon,
    points: readonly SpatialPoint[],
  ): Promise<{ engine: 'postgis' | 'geodesic'; meters: ReadonlyMap<string, number> }>;
};

export type GeographyRecordReader = {
  read(scope: Scope, modules: readonly string[]): Promise<GeographyRecords>;
};
export const createGeographyService = ({
  reader,
  gateway,
  spatial,
}: {
  reader: GeographyRecordReader;
  gateway: GeographyGateway;
  spatial: SpatialEngine;
}) => ({
  catalogue: gateway.catalogue,
  async query(scope: Scope, raw: unknown): Promise<GeographyResult> {
    const input = GeographyQuery.parse(raw);
    const official = await gateway.query(input);
    if (!input.polygon) return { ...official, related: [], unlocated: [] };
    const { related, unlocated, outside } = relateRecords(
      await reader.read(scope, ['Eventos', 'Demandas', 'Actores', 'Narrativas', 'Reportes']),
      input.polygon,
      input.concessionCode,
    );
    const influence = input.influenceMeters ?? 0;
    if (!influence) return { ...official, related, unlocated };
    // Area of influence: records whose own coordinates lie within `influence` metres of the
    // official boundary, nearest first. Localities and names never place a record here.
    const { engine, meters } = await spatial.distances(
      input.polygon,
      outside.map((r) => ({ key: `${r.module}\u0000${r.id}`, at: r.at })),
    );
    const near = outside
      .map((r) => ({ ...r, distance: meters.get(`${r.module}\u0000${r.id}`) ?? Infinity }))
      .filter((r) => r.distance <= influence)
      .sort((a, b) => a.distance - b.distance);
    const label = engine === 'postgis' ? 'PostGIS, elipsoide WGS84' : 'aproximación geodésica';
    return {
      ...official,
      related: [
        ...related,
        ...near.map((r) => ({
          id: r.id,
          module: r.module,
          relationship: 'proximity' as const,
          evidence: `Coordenadas explícitas a ${Math.round(r.distance)} m del límite oficial (${label})`,
          distanceMeters: Math.round(r.distance),
        })),
      ],
      unlocated,
      influence: { meters: influence, engine },
    };
  },
});
export type GeographyService = ReturnType<typeof createGeographyService>;
