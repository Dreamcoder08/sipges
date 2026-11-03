import type { ParityCase } from '../types.ts';

/**
 * Synthetic rows of the geography context in DEFAULT_TENANT and OTHER_TENANT (see ../fixtures.ts).
 * None are needed: every case is answered before the INGEMMET gateway, which a parity run cannot
 * reach deterministically, so successful catalogue and query answers are covered by Go tests
 * with a fake gateway (apps/api-go/internal/geography) instead.
 */
export const seed = '';

const unit = {
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
};

type QueryOptions = {
  readonly auth?: 'admin' | 'consulta' | 'none';
  readonly origin?: boolean;
  readonly headers?: Readonly<Record<string, string>>;
};

/** A query POST: by default the administrator's, same-origin, with a JSON body. */
const query = (json: unknown, { auth = 'admin', origin = true, headers }: QueryOptions = {}) => ({
  method: 'POST' as const,
  path: '/system/geography/query',
  body: { json },
  ...(auth === 'none' ? {} : { auth }),
  ...(origin ? { sameOrigin: true as const } : {}),
  ...(headers ? { headers } : {}),
});

export const cases: readonly ParityCase[] = [
  {
    name: 'geography: catalogue without a session',
    method: 'GET',
    path: '/system/geography/catalogue',
  },
  {
    name: 'geography: query without a session',
    ...query({ layerId: 0, bbox: [0, 0, 1, 1] }, { auth: 'none' }),
  },
  {
    name: 'geography: catalogue of a project without a grant',
    method: 'GET',
    path: '/system/geography/catalogue',
    auth: 'admin',
    headers: { 'x-sipges-scope': 'PARITY/OTRO' },
  },
  {
    name: 'geography: query of a project without a grant',
    ...query({ layerId: 0, bbox: [0, 0, 1, 1] }, { headers: { 'x-sipges-scope': 'PARITY/OTRO' } }),
  },
  {
    name: 'geography: query without Origin',
    ...query({ layerId: 0, bbox: [0, 0, 1, 1] }, { origin: false }),
  },
  // A form body is not JSON: the route's own parse fails (request.ts sends only json or form).
  {
    name: 'geography: invalid JSON',
    method: 'POST',
    path: '/system/geography/query',
    auth: 'admin',
    sameOrigin: true,
    body: { form: { layerId: '0' } },
  },
  { name: 'geography: area wider than 5°', ...query({ layerId: 0, bbox: [0, 0, 100, 80] }) },
  { name: 'geography: reversed bounds', ...query({ layerId: 0, bbox: [4, 0, 0, 4] }) },
  {
    name: 'geography: polygon wider than 5°',
    ...query({
      layerId: 0,
      polygon: {
        type: 'Polygon',
        coordinates: [
          [
            [0, 0],
            [6, 0],
            [6, 1],
            [0, 1],
            [0, 0],
          ],
        ],
      },
    }),
  },
  {
    name: 'geography: self-intersecting polygon',
    ...query({
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
    }),
  },
  {
    name: 'geography: unknown service',
    ...query({ serviceId: 'SERV_OTRO', layerId: 0, bbox: [0, 0, 1, 1] }),
  },
  {
    name: 'geography: supplied URL',
    ...query({ layerId: 0, bbox: [0, 0, 1, 1], url: 'https://evil.test' }),
  },
  {
    name: 'geography: concession without a polygon',
    ...query({ layerId: 0, bbox: [0, 0, 1, 1], concessionCode: 'C1' }),
  },
  {
    name: 'geography: influence beyond 20 km',
    ...query({ layerId: 0, polygon: unit, influenceMeters: 20_001 }),
  },
  // The read-only role may query (a read-only POST); the invalid area keeps INGEMMET out of it.
  {
    name: 'geography: read-only account reaches validation',
    ...query({ layerId: 0, bbox: [0, 0, 100, 80] }, { auth: 'consulta' }),
  },
  {
    name: 'geography: oversized query',
    ...query({ layerId: 0, bbox: [0, 0, 1, 1], pad: 'x'.repeat(100_000) }),
  },
];
