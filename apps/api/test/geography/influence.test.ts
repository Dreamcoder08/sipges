import { randomBytes } from 'node:crypto';
import type { GeographyCatalogue, GeographyPolygon } from '@mascli/contracts';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createGeographyService } from '../../src/contexts/geography/application/index.ts';
import { distanceToPolygon } from '../../src/contexts/geography/domain/distance.ts';
import {
  createPostgisSpatialEngine,
  geodesicSpatialEngine,
} from '../../src/contexts/geography/infrastructure/spatial-engine.ts';
import type { SqlClient } from '../../src/platform/database/sql-client.ts';
import { postgresClient } from '../../src/platform/database/postgres.ts';

// A synthetic 0.01° square near Sechura; no official geometry or project data.
const SQUARE: GeographyPolygon = {
  type: 'Polygon',
  coordinates: [
    [
      [-80.9, -5.6],
      [-80.89, -5.6],
      [-80.89, -5.59],
      [-80.9, -5.59],
      [-80.9, -5.6],
    ],
  ],
};
/** One degree of latitude, metres, on the mean sphere. */
const DEGREE = 111_195;

describe('distance to a polygon', () => {
  it('is zero inside and the shortest way to the boundary outside', () => {
    expect(distanceToPolygon([-80.895, -5.595], SQUARE)).toBe(0);
    // 0.01° north of the northern edge.
    expect(distanceToPolygon([-80.895, -5.58], SQUARE)).toBeCloseTo(0.01 * DEGREE, -1);
    // Diagonal from the north-east corner.
    const corner = distanceToPolygon([-80.88, -5.58], SQUARE);
    const east = 0.01 * DEGREE * Math.cos((5.58 * Math.PI) / 180);
    expect(corner).toBeCloseTo(Math.hypot(east, 0.01 * DEGREE), -1);
  });
});

const catalogue: GeographyCatalogue = {
  status: 'verified',
  checkedAt: '2026-10-19',
  serviceUrl: 'https://geocatmin.ingemmet.gob.pe',
  attribution: 'INGEMMET',
  layers: [],
  services: [],
};

describe('area of influence', () => {
  const service = createGeographyService({
    spatial: geodesicSpatialEngine,
    gateway: {
      catalogue: async () => catalogue,
      query: async () => ({ features: [], truncated: false, source: 'INGEMMET' }),
    },
    reader: {
      read: async () => ({
        Eventos: [
          { id: 'EV-IN', payload: { Longitud: -80.895, Latitud: -5.595 } },
          { id: 'EV-1KM', payload: { Longitud: -80.895, Latitud: -5.581 } },
          { id: 'EV-5KM', payload: { Longitud: -80.895, Latitud: -5.545 } },
          { id: 'EV-NAME', payload: { Territorio: 'Sechura' } },
          {
            id: 'EV-REF',
            payload: {
              Longitud: -80.895,
              Latitud: -5.585,
              Concesion_Codigo: 'C1',
              Concesion_Fuente: 'Resolución sintética',
            },
          },
        ],
      }),
    },
  });
  const scope = { companyId: 'ACME', projectId: 'P1' };

  it('adds records within the requested distance, nearest first, with their distance', async () => {
    const result = await service.query(scope, {
      layerId: 0,
      polygon: SQUARE,
      concessionCode: 'C1',
      influenceMeters: 3000,
    });
    expect(result.related.map((r) => [r.id, r.relationship])).toEqual([
      ['EV-IN', 'geometry'],
      ['EV-REF', 'explicit-reference'],
      ['EV-1KM', 'proximity'],
    ]);
    expect(result.related[2]?.distanceMeters).toBeGreaterThan(900);
    expect(result.related[2]?.distanceMeters).toBeLessThan(1100);
    expect(result.related[2]?.evidence).toMatch(/aproximación geodésica/);
    expect(result.influence).toEqual({ meters: 3000, engine: 'geodesic' });
    // A written locality never places a record in the area of influence.
    expect(result.unlocated.map((u) => u.id)).toEqual(['EV-NAME']);
  });

  it('keeps the strict relation when no area of influence is requested', async () => {
    const result = await service.query(scope, { layerId: 0, polygon: SQUARE });
    expect(result.related.map((r) => r.id)).toEqual(['EV-IN']);
    expect(result.influence).toBeUndefined();
  });

  it('falls back to the geodesic approximation without the PostGIS extension', async () => {
    const queries: string[] = [];
    const sql: SqlClient = {
      query: async <Row>(text: string) => {
        queries.push(text);
        return [{ present: false }] as Row[];
      },
      exec: async () => undefined,
      transaction: async (fn) => fn(sql),
    };
    const engine = createPostgisSpatialEngine(sql);
    const first = await engine.distances(SQUARE, [{ key: 'a', at: [-80.895, -5.581] }]);
    await engine.distances(SQUARE, [{ key: 'a', at: [-80.895, -5.581] }]);
    expect(first.engine).toBe('geodesic');
    // The extension check is cached rather than repeated on every query.
    expect(queries).toHaveLength(1);
  });
});

/**
 * Real PostGIS (opt-in, like test/integration/postgres.test.ts): the extension is created only
 * in a throwaway database, and skipped where the server does not ship PostGIS.
 */
const adminUrl = process.env.MASCLI_TEST_DATABASE_URL;

describe.skipIf(!adminUrl)('PostGIS distances', () => {
  const name = `mascli_gis_${randomBytes(6).toString('hex')}`;
  let admin: postgres.Sql;
  let pool: { client: SqlClient; close: () => Promise<void> } | null = null;
  let installed = false;

  beforeAll(async () => {
    admin = postgres(adminUrl ?? '', { max: 1, onnotice: () => undefined });
    await admin.unsafe(`CREATE DATABASE ${name}`);
    const url = new URL(adminUrl ?? '');
    url.pathname = `/${name}`;
    pool = postgresClient(url.toString());
    try {
      await pool.client.exec('CREATE EXTENSION IF NOT EXISTS postgis');
      installed = true;
    } catch {
      installed = false;
    }
  });

  afterAll(async () => {
    await pool?.close();
    await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.end();
  });

  it('agrees with the geodesic approximation within one percent', async (ctx) => {
    if (!installed || !pool) ctx.skip();
    const points = [
      { key: 'inside', at: [-80.895, -5.595] as const },
      { key: 'north', at: [-80.895, -5.581] as const },
      { key: 'corner', at: [-80.87, -5.57] as const },
      { key: 'far', at: [-80.8, -5.5] as const },
    ];
    const engine = createPostgisSpatialEngine(pool?.client as SqlClient);
    const gis = await engine.distances(SQUARE, points);
    const approx = await geodesicSpatialEngine.distances(SQUARE, points);
    expect(gis.engine).toBe('postgis');
    expect(gis.meters.get('inside')).toBe(0);
    for (const p of points.slice(1)) {
      const a = gis.meters.get(p.key) ?? NaN;
      const b = approx.meters.get(p.key) ?? NaN;
      expect(Math.abs(a - b) / a).toBeLessThan(0.01);
    }
  });
});
