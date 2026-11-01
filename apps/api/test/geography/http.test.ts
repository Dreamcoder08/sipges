import { Hono } from 'hono';
import { expect, it } from 'vitest';
import type { AppEnv } from '../../src/platform/http/env.ts';
import { geographyRequestLimit, geographyRoutes } from '../../src/contexts/geography/http/index.ts';
import { createGeographyService } from '../../src/contexts/geography/application/index.ts';
import { geodesicSpatialEngine } from '../../src/contexts/geography/infrastructure/spatial-engine.ts';
import type { GeographyCatalogue } from '@sipges/contracts';
const catalogue: GeographyCatalogue = {
  status: 'verified',
  checkedAt: '2026-10-17',
  serviceUrl: 'https://geocatmin.ingemmet.gob.pe',
  attribution: 'INGEMMET',
  layers: [],
  services: [],
};
it('rejects supplied URLs before provider calls and carries resolved scope into reader', async () => {
  const seen: unknown[] = [];
  let calls = 0;
  const geography = createGeographyService({
    spatial: geodesicSpatialEngine,
    gateway: {
      catalogue: async () => catalogue,
      query: async () => {
        calls++;
        return { features: [], truncated: false, source: 'INGEMMET' };
      },
    },
    reader: {
      read: async (scope) => {
        seen.push(scope);
        return { Eventos: [{ id: scope.projectId, payload: { Longitud: 0.5, Latitud: 0.5 } }] };
      },
    },
  });
  const app = new Hono<AppEnv>()
    .use('*', geographyRequestLimit())
    .use('*', async (c, next) => {
      c.set('scope', { companyId: 'ACME', projectId: 'P2' });
      await next();
    })
    .route('/', geographyRoutes({ geography }));
  const post = (body: unknown) =>
    app.request('/system/geography/query', { method: 'POST', body: JSON.stringify(body) });
  expect((await post({ layerId: 0, bbox: [0, 0, 1, 1], url: 'https://evil.test' })).status).toBe(
    422,
  );
  expect(calls).toBe(0);
  const response = await post({
    layerId: 0,
    polygon: {
      type: 'Polygon',
      coordinates: [
        [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 1],
          [0, 0],
        ],
      ],
    },
    concessionCode: 'C1',
  });
  expect(response.status).toBe(200);
  expect(seen).toEqual([{ companyId: 'ACME', projectId: 'P2' }]);
  expect(await response.json()).toMatchObject({
    related: [{ id: 'P2', relationship: 'geometry' }],
  });
});
it('reports upstream failures and rejects oversized bodies', async () => {
  const geography = createGeographyService({
    spatial: geodesicSpatialEngine,
    gateway: {
      catalogue: async () => catalogue,
      query: async () => {
        throw new Error('timeout');
      },
    },
    reader: { read: async () => ({}) },
  });
  const app = new Hono<AppEnv>()
    .use('*', geographyRequestLimit())
    .route('/', geographyRoutes({ geography }));
  expect(
    (
      await app.request('/system/geography/query', {
        method: 'POST',
        body: JSON.stringify({ layerId: 0, bbox: [0, 0, 1, 1] }),
      })
    ).status,
  ).toBe(502);
  expect(
    (await app.request('/system/geography/query', { method: 'POST', body: ' '.repeat(100001) }))
      .status,
  ).toBe(413);
});
it('stops consuming an oversized streaming query early', async () => {
  let consumed = 0;
  const geography = createGeographyService({
    spatial: geodesicSpatialEngine,
    gateway: {
      catalogue: async () => catalogue,
      query: async () => ({ features: [], truncated: false, source: 'INGEMMET' }),
    },
    reader: { read: async () => ({}) },
  });
  const app = new Hono<AppEnv>()
    .use('*', geographyRequestLimit())
    .route('/', geographyRoutes({ geography }));
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      consumed++;
      controller.enqueue(new TextEncoder().encode('x'.repeat(60000)));
      if (consumed === 10) controller.close();
    },
  });
  const req = new Request('http://localhost/system/geography/query', {
    method: 'POST',
    body: stream,
    duplex: 'half',
  } as RequestInit);
  expect((await app.request(req)).status).toBe(413);
  expect(consumed).toBeLessThan(10);
});
