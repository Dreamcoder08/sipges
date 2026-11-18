import type { Method, ParityCase } from '../types.ts';

/**
 * The update notice of a managed desktop install (apps/api/src/contexts/system/http/
 * desktop-update-routes.ts), mounted only with SIPGES_DESKTOP_UPDATE_DIR. `cases` run in the
 * first stage, where neither API has the folder; the second stage restarts both with a folder of
 * their own each (main.ts) and runs `switchOn`, then `brokenStatus` and `missingStatus` after
 * rewriting status.json. Synthetic versions only.
 */
export const seed = '';

const path = '/system/desktop/update';
const dismiss = `${path}/dismiss`;
const SECOND = { 'x-sipges-scope': 'PARITY/PRJ-B' };

/** status.json as the launcher writes it, for both APIs' folders. */
export const STATUS = {
  format: 1,
  installed: '1.0.0',
  available: { version: '1.1.0', notes: 'Corrige el filtro de registros.\nNuevo resumen semanal.' },
  checkedAt: '2026-11-11T00:00:00Z',
};

const routes: readonly (readonly [Method, string, string])[] = [
  ['GET', path, 'status'],
  ['POST', path, 'start'],
  ['POST', dismiss, 'dismiss'],
];

/** Who asks, for every route; writes are same-origin unless the case says otherwise. */
const callers = (prefix: string): ParityCase[] =>
  routes.flatMap(([method, p, label]): ParityCase[] => {
    const write = method === 'POST' ? ({ sameOrigin: true } as const) : {};
    return [
      { name: `${prefix} ${label} without a session`, method, path: p, ...write },
      {
        name: `${prefix} ${label} with an unknown session`,
        method,
        path: p,
        headers: { cookie: `sipges_session=${'0'.repeat(64)}` },
        ...write,
      },
      { name: `${prefix} ${label} read-only role`, method, path: p, auth: 'consulta', ...write },
      {
        name: `${prefix} ${label} analista before choosing`,
        method,
        path: p,
        auth: 'multi',
        ...write,
      },
      {
        name: `${prefix} ${label} analista in the second project`,
        method,
        path: p,
        auth: 'multi',
        headers: SECOND,
        ...write,
      },
      {
        name: `${prefix} ${label} admin in an ungranted project`,
        method,
        path: p,
        auth: 'admin',
        headers: SECOND,
        ...write,
      },
    ];
  });

/** First stage: no SIPGES_DESKTOP_UPDATE_DIR, so neither API has the routes. */
export const cases: readonly ParityCase[] = [
  ...routes.map(([method, p, label]): ParityCase => ({
    name: `desktop-update off: ${label} admin`,
    method,
    path: p,
    auth: 'admin',
    ...(method === 'POST' ? { sameOrigin: true } : {}),
  })),
  { name: 'desktop-update off: HEAD admin', method: 'HEAD', path, auth: 'admin' },
  ...callers('desktop-update off:'),
];

const admin = (
  name: string,
  method: Method,
  p: string,
  extra: Partial<ParityCase> = {},
): ParityCase => ({
  name: `desktop-update on: ${name}`,
  method,
  path: p,
  auth: 'admin',
  ...(method === 'GET' || method === 'HEAD' ? {} : { sameOrigin: true }),
  ...extra,
});

/** An admin write that is not same-origin: the shared Origin gate refuses it. */
const crossSite = (
  name: string,
  method: Method,
  p: string,
  headers: Readonly<Record<string, string>>,
): ParityCase => ({ name: `desktop-update on: ${name}`, method, path: p, auth: 'admin', headers });

/** Second stage, valid status: reads, refusals and bodies before the start, then dismiss. */
export const switchOn: readonly ParityCase[] = [
  admin('status', 'GET', path, { present: ['"available":"1.1.0"', '"dismissed":false'] }),
  admin('HEAD status', 'HEAD', path),
  admin('status with a query string', 'GET', `${path}?version=9.9.9`),
  admin('trailing slash', 'GET', `${path}/`),
  admin('POST trailing slash', 'POST', `${path}/`),
  admin('GET dismiss', 'GET', dismiss),
  admin('unknown path below', 'GET', `${path}/other`),
  admin('a longer name is another path', 'GET', `${path}x`),
  admin('PUT', 'PUT', path),
  admin('DELETE dismiss', 'DELETE', dismiss),
  ...callers('desktop-update on:'),
  ...routes
    .filter(([method]) => method === 'POST')
    .flatMap(([method, p, label]): ParityCase[] => [
      crossSite(`${label} without Origin`, method, p, {}),
      crossSite(`${label} cross-site`, method, p, { origin: 'https://evil.example' }),
      crossSite(`${label} Origin null`, method, p, { origin: 'null' }),
      admin(`${label} body naming another project`, method, p, {
        body: { json: { project_id: 'PRJ-B', company_id: 'PARITY' } },
      }),
      admin(`${label} malformed JSON body`, method, p, { body: { raw: '{"version":' } }),
      admin(`${label} JSON array body`, method, p, { body: { raw: '[1,2]' } }),
      admin(`${label} text body`, method, p, {
        body: { raw: 'version=9.9.9' },
        headers: { 'content-type': 'text/plain' },
      }),
      admin(`${label} form body`, method, p, { body: { form: { version: '9.9.9' } } }),
    ]),
  // The client cannot choose the version: the verified one is requested.
  admin('start naming another version', 'POST', path, {
    body: { json: { version: '9.9.9', release: '/tmp/evil' } },
    present: ['"version":"1.1.0"'],
    absent: ['9.9.9'],
  }),
  admin('start', 'POST', path),
  // The dismiss cases with a body above already answered 204, so the notice reads dismissed.
  admin('status after the start', 'GET', path, {
    present: ['"available":"1.1.0"', '"dismissed":true'],
  }),
  admin('dismiss', 'POST', dismiss),
  admin('dismiss again', 'POST', dismiss),
  admin('status after dismiss', 'GET', path, { present: ['"dismissed":true'] }),
];

/** Second stage, status.json cut short: nothing is offered and nothing starts. */
export const brokenStatus: readonly ParityCase[] = [
  admin('broken status', 'GET', path, { present: ['"available":null'] }),
  admin('start with a broken status', 'POST', path),
];

/** Second stage, status.json removed. */
export const missingStatus: readonly ParityCase[] = [
  admin('missing status', 'GET', path, { present: ['"installed":null'] }),
  admin('start with a missing status', 'POST', path),
];
