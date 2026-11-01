import type { GeographyPolygon } from '@sipges/contracts';
import { log } from '../../../platform/observability/logger.ts';
import type { SqlClient } from '../../../platform/database/sql-client.ts';
import { distanceToPolygon } from '../domain/distance.ts';
import type { SpatialEngine, SpatialPoint } from '../application/index.ts';

/** In-process geodesic approximation; used where PostGIS is not installed. */
export const geodesicSpatialEngine: SpatialEngine = {
  async distances(polygon, points) {
    return {
      engine: 'geodesic',
      meters: new Map(points.map((p) => [p.key, distanceToPolygon(p.at, polygon)])),
    };
  },
};

/** How long an answer about the extension is trusted before asking again. */
const RECHECK_MS = 10 * 60_000;

/**
 * PostGIS distances on the WGS84 spheroid (`geography`), computed from the request alone:
 * no table is read or written, so tenancy and markings stay with the record reader. The
 * extension is never created here; until an operator installs it (docs/adr/0025) and if a
 * query fails, the geodesic approximation answers instead.
 */
export const createPostgisSpatialEngine = (
  sql: SqlClient,
  options: { now?: () => number } = {},
): SpatialEngine => {
  const now = options.now ?? Date.now;
  let known: { available: boolean; at: number } | null = null;
  const available = async () => {
    if (known && now() - known.at < RECHECK_MS) return known.available;
    try {
      const [row] = await sql.query<{ present: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'postgis') AS present`,
      );
      known = { available: Boolean(row?.present), at: now() };
    } catch {
      known = { available: false, at: now() };
    }
    return known.available;
  };
  return {
    async distances(polygon: GeographyPolygon, points: readonly SpatialPoint[]) {
      if (!points.length || !(await available()))
        return geodesicSpatialEngine.distances(polygon, points);
      try {
        const rows = await sql.query<{ key: string; meters: number | string }>(
          `SELECT p.key,
                  ST_Distance(
                    ST_SetSRID(ST_GeomFromGeoJSON($1), 4326)::geography,
                    ST_SetSRID(ST_MakePoint(p.lon, p.lat), 4326)::geography
                  ) AS meters
             FROM jsonb_to_recordset($2::jsonb) AS p(key text, lon float8, lat float8)`,
          [
            JSON.stringify(polygon),
            JSON.stringify(points.map((p) => ({ key: p.key, lon: p.at[0], lat: p.at[1] }))),
          ],
        );
        return {
          engine: 'postgis',
          meters: new Map(rows.map((row) => [row.key, Number(row.meters)])),
        };
      } catch (error) {
        log('warn', 'postgis_distance_failed', { error });
        known = { available: false, at: now() };
        return geodesicSpatialEngine.distances(polygon, points);
      }
    },
  };
};
