import { expect, it } from 'vitest';
import { GeographyQuery, type GeographyPolygon } from '@sipges/contracts';
import { pointInPolygon } from '../../src/contexts/geography/domain/geometry.ts';
import { relateRecords } from '../../src/contexts/geography/application/relations.ts';
import { createIngemmetGateway } from '../../src/contexts/geography/infrastructure/index.ts';
const polygon: GeographyPolygon = {
  type: 'Polygon',
  coordinates: [
    [
      [0, 0],
      [4, 0],
      [4, 4],
      [0, 4],
      [0, 0],
    ],
    [
      [1, 1],
      [1, 2],
      [2, 2],
      [2, 1],
      [1, 1],
    ],
  ],
};
it('rejects arbitrary destinations, unbounded areas and reversed coordinates', () => {
  expect(
    GeographyQuery.safeParse({ layerId: 0, bbox: [0, 0, 100, 80], url: 'https://evil.test' })
      .success,
  ).toBe(false);
  expect(GeographyQuery.safeParse({ layerId: 0, bbox: [4, 0, 0, 4] }).success).toBe(false);
});
it('excludes holes and includes polygon boundaries', () => {
  expect(pointInPolygon([1.5, 1.5], polygon)).toBe(false);
  expect(pointInPolygon([0, 2], polygon)).toBe(true);
  expect(pointInPolygon([1, 1.5], polygon)).toBe(true);
});
it('never geocodes names and distinguishes documented references', () => {
  const result = relateRecords(
    {
      Eventos: [
        { id: 'name', payload: { Territorio: 'Sechura' } },
        { id: 'point', payload: { Longitud: 3, Latitud: 3 } },
        { id: 'ref', payload: { Concesion_Codigo: 'C1', Concesion_Fuente: 'acta 4' } },
      ],
    },
    polygon,
    'C1',
  );
  expect(result.related.map((r) => [r.id, r.relationship])).toEqual([
    ['point', 'geometry'],
    ['ref', 'explicit-reference'],
  ]);
  expect(result.unlocated.map((r) => r.id)).toEqual(['name', 'ref']);
});
it('discovers actual metadata only on fixed official services and bounds response size', async () => {
  const urls: string[] = [];
  const gateway = createIngemmetGateway({
    fetch: async (input) => {
      urls.push(String(input));
      return Response.json({
        layers: [
          { id: 3, name: 'Oficial sintético', type: 'Feature Layer', minScale: 1000, maxScale: 0 },
        ],
        capabilities: 'Map,Query',
        copyrightText: 'INGEMMET',
      });
    },
  });
  expect((await gateway.catalogue()).layers[0]).toMatchObject({ id: 3, minScale: 1000 });
  expect(
    urls.every(
      (u) =>
        new URL(u).origin === 'https://geocatmin.ingemmet.gob.pe' &&
        /\/SERV_[A-Z_]+\/MapServer/.test(new URL(u).pathname),
    ),
  ).toBe(true);
  const limited = createIngemmetGateway({
    maxBytes: 10,
    fetch: async () => new Response('x'.repeat(11)),
  });
  expect((await limited.catalogue()).status).toBe('unavailable');
});
it('rejects nonzero-area self intersections', () => {
  expect(
    GeographyQuery.safeParse({
      layerId: 0,
      polygon: {
        type: 'Polygon',
        coordinates: [
          [
            [0, 0],
            [3, 3],
            [0, 3],
            [2, 0],
            [0, 0],
          ],
        ],
      },
    }).success,
  ).toBe(false);
});
it('normalizes ArcGIS rings, reports truncation and excludes group layers', async () => {
  let queried: URL | undefined;
  const gateway = createIngemmetGateway({
    fetch: async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/query')) {
        queried = url;
        return Response.json({
          features: [{ attributes: { CODIGOU: 'synthetic' } }],
          exceededTransferLimit: true,
        });
      }
      return Response.json({
        layers: [
          {
            id: 0,
            type: 'Feature Layer',
            name: 'Derechos',
            capabilities: 'Query',
            minScale: 0,
            maxScale: 0,
          },
          { id: 1, type: 'Group Layer', name: 'Grupo' },
        ],
        capabilities: 'Map,Query',
      });
    },
  });
  const result = await gateway.query(
    GeographyQuery.parse({
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
    }),
  );
  expect(result.truncated).toBe(true);
  expect(result.features[0]?.attributes).toEqual({ CODIGOU: 'synthetic' });
  if (!queried) throw new Error('query not called');
  const shape = JSON.parse(queried.searchParams.get('geometry') ?? 'null') as {
    rings: number[][][];
  };
  expect(shape.rings[0]?.[1]).toEqual([0, 1]);
  await expect(
    gateway.query(GeographyQuery.parse({ layerId: 1, bbox: [0, 0, 1, 1] })),
  ).rejects.toThrow('Capa no verificable');
});
it('accepts strict decimal form coordinates and excludes polygon records inside holes', () => {
  const r = relateRecords(
    {
      Eventos: [
        { id: 'form', payload: { Longitud: '3.0', Latitud: '3.0' } },
        { id: 'junk', payload: { Longitud: '3 west', Latitud: '3' } },
        {
          id: 'hole',
          payload: {
            geometry: {
              type: 'Polygon',
              coordinates: [
                [
                  [1.2, 1.2],
                  [1.8, 1.2],
                  [1.8, 1.8],
                  [1.2, 1.8],
                  [1.2, 1.2],
                ],
              ],
            },
          },
        },
      ],
    },
    polygon,
  );
  expect(r.related.map((i) => i.id)).toEqual(['form']);
  expect(r.unlocated.map((i) => i.id)).toEqual(['junk']);
});
it('rejects exterior holes and touching self intersections', () => {
  expect(
    GeographyQuery.safeParse({
      layerId: 0,
      polygon: {
        type: 'Polygon',
        coordinates: [
          [
            [0, 0],
            [4, 0],
            [4, 4],
            [0, 4],
            [0, 0],
          ],
          [
            [4.1, 4.1],
            [4.5, 4.1],
            [4.5, 4.5],
            [4.1, 4.5],
            [4.1, 4.1],
          ],
        ],
      },
    }).success,
  ).toBe(false);
  expect(
    GeographyQuery.safeParse({
      layerId: 0,
      polygon: {
        type: 'Polygon',
        coordinates: [
          [
            [0, 0],
            [2, 0],
            [2, 2],
            [1, 1],
            [0, 2],
            [1, 1],
            [0, 0],
          ],
        ],
      },
    }).success,
  ).toBe(false);
});
it('does not make a later caller wait on an earlier caller that never finishes', async () => {
  // On Workers, I/O started by one request cannot complete for another: a cancelled first
  // request leaves its fetch pending forever. A later caller must do its own lookup.
  let calls = 0;
  const gateway = createIngemmetGateway({
    fetch: async () => {
      calls += 1;
      if (calls === 1) return new Promise<Response>(() => {});
      return Response.json({
        layers: [{ id: 7, name: 'Sintética', type: 'Feature Layer' }],
        capabilities: 'Map',
      });
    },
  });
  void gateway.catalogue();
  const later = await Promise.race([
    gateway.catalogue(),
    new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 500)),
  ]);
  expect(later).not.toBe('hung');
  expect(later).toMatchObject({ status: 'verified' });
});
