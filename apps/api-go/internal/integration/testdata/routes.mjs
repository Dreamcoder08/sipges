// Records how the TypeScript API answers the integration runtime routes, for the Go port's test
// (../http/runtime_fixtures_test.go): the real Hono routes of apps/api/src/contexts/integration/http
// (media, authorized sources, the ingest and signal webhooks, API key revocation) over the real
// media-monitor and authorized-sources services, with in-memory stores, a fixed clock and fake
// gateways, so the answers depend only on the request. Run from the repository root after
// changing either side:
//
//   node apps/api-go/internal/integration/testdata/routes.mjs          # rewrites the fixture
//   node apps/api-go/internal/integration/testdata/routes.mjs --check  # exit 1 when it drifted
//
// Every input is synthetic: no real record, key or feed is read.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Hono } from '../../../../api/node_modules/hono/dist/index.js';
import { format, resolveConfig } from 'prettier';
import { createAuthorizedSourcesService } from '../../../../api/src/contexts/integration/application/authorized-sources.ts';
import { createMediaMonitorService } from '../../../../api/src/contexts/integration/application/media-monitor.ts';
import { parseFeed } from '../../../../api/src/contexts/integration/domain/feeds.ts';
import { apiKeyRoutes } from '../../../../api/src/contexts/integration/http/api-key-routes.ts';
import { ingestRoutes } from '../../../../api/src/contexts/integration/http/ingest-routes.ts';
import { mediaRoutes } from '../../../../api/src/contexts/integration/http/media-routes.ts';
import {
  sourceRequestLimit,
  sourceRoutes,
} from '../../../../api/src/contexts/integration/http/source-routes.ts';
import { signalRoutes } from '../../../../api/src/contexts/integration/http/signal-routes.ts';

const OUT = fileURLToPath(new URL('./routes.json', import.meta.url));
const NOW = new Date('2026-11-05T12:00:00.000Z');
const TENANT = 'SIPGES/PRJ-SECHURA';

/** The feed every fake read returns (also parsed by the Go test with domain.ParseFeed). */
export const FEED = readFileSync(fileURLToPath(new URL('./feed.xml', import.meta.url)), 'utf8');

const captured = [];

const feedStore = {
  list: async () => [],
  create: async (tenantId, feed) => {
    if (feed.name === 'LLENO') return 'limit';
    if (feed.url === 'https://duplicada.example/rss') return 'duplicate';
    return storedFeed(41, feed);
  },
  update: async (tenantId, id, feed) => {
    if (id === 404) return null;
    if (feed.url === 'https://duplicada.example/rss') return 'duplicate';
    return storedFeed(id, feed);
  },
  remove: async (tenantId, id) => id !== 404,
  claimDue: async () => [],
  finish: async () => undefined,
};
const storedFeed = (id, feed) => ({
  id,
  name: feed.name,
  url: feed.url,
  keywords: feed.keywords,
  territory: feed.territory,
  authorization_note: feed.authorization_note,
  enabled: feed.enabled,
  updated_by: feed.actor,
  updated_at: feed.at,
  last_poll_at: null,
  last_poll_error: '',
  last_imported: 0,
  last_matched: 0,
});

const gateway = {
  read: async (url) => {
    const code = /error-([a-z_]+)/.exec(url)?.[1];
    if (code) throw new Error(code === 'other' ? 'boom' : `feed_${code}`);
    return parseFeed(FEED);
  },
};

const importer = {
  createOnce: async (tenantId, canonicalId, payload) => {
    captured.push({ id: canonicalId, payload });
    if (payload.Territorio === 'colision') throw new Error('source_identity_collision');
    return { id: canonicalId, created: payload.Territorio !== 'repetida' };
  },
};

const POSTS = [
  {
    id: 101,
    url: 'https://www.defensoria.gob.pe/sintetica-uno/',
    title: 'Publicación sintética «uno»',
    excerpt: 'Extracto sintético con "comillas" y   separador',
    published_at: '2026-10-01T10:00:00.000Z',
  },
  {
    id: 2147483647,
    url: 'https://www.defensoria.gob.pe/sintetica-dos/?a=1&b=%C3%B1',
    title: 'Dos',
    excerpt: '',
    published_at: '2026-10-02T00:00:00.000Z',
  },
];
const sourceGateway = {
  preview: async (query) => {
    if (query === 'falla') throw new Error('source_unavailable');
    return query === 'vacia' ? [] : POSTS;
  },
  get: async (id) => {
    const post = POSTS.find((p) => p.id === id);
    if (!post) throw new Error('source_not_found');
    return post;
  },
};
const settings = {
  get: async () => ({
    enabled: false,
    query: '',
    territory: '',
    authorization_note: '',
    revision: 0,
    updated_by: '',
    updated_at: null,
    last_poll_at: null,
    last_poll_error: '',
    last_imported: 0,
    last_duplicates: 0,
  }),
  save: async (tenantId, input, username, at) => ({
    ...input,
    revision: 4,
    updated_by: username,
    updated_at: at,
    last_poll_at: null,
    last_poll_error: '',
    last_imported: 0,
    last_duplicates: 0,
  }),
  claimPoll: async () => false,
  finishPoll: async () => undefined,
  activeTenants: async () => [],
};

const SECRET = 'S'.repeat(43);
const PRINCIPALS = {
  [`mscli_aaaaaaaaaaaa_${SECRET}`]: { access: 'write', tenantId: TENANT },
  [`mscli_bbbbbbbbbbbb_${SECRET}`]: { access: 'read', tenantId: TENANT },
  [`mscli_cccccccccccc_${SECRET}`]: { access: 'write', tenantId: 'PARITY' },
};
const keys = {
  authenticate: async (token) => {
    const p = token ? PRINCIPALS[token] : undefined;
    return p
      ? { keyId: 7, tenantId: p.tenantId, name: 'sintetica', access: p.access, clearance: 'full' }
      : null;
  },
  revoke: async (tenantId, id) => id === 12,
  list: async () => [],
  create: async () => ({ ok: false, error: 'duplicate' }),
};
const ingest = {
  ingest: async (request) => ({
    status: request.slug === 'parcial' ? 207 : 201,
    body: {
      slug: request.slug,
      project: request.projectId,
      key: request.idempotencyKey,
      body: request.body,
    },
    replayed: request.idempotencyKey === 'repetida',
  }),
};

const clock = () => NOW;
const app = new Hono();
app.use('*', async (c, next) => {
  c.set('identity', { username: 'parity-admin' });
  c.set('scope', { companyId: 'SIPGES', projectId: 'PRJ-SECHURA' });
  await next();
});
app.use('/system/intelligence/sources/*', sourceRequestLimit());
app.use('/system/v4/media/*', sourceRequestLimit());
app.route(
  '/',
  sourceRoutes({
    sources: createAuthorizedSourcesService({
      gateway: sourceGateway,
      settings,
      importer,
      clock,
    }),
  }),
);
app.route('/', signalRoutes({ keys, ingest }));
app.route(
  '/',
  mediaRoutes({
    media: createMediaMonitorService({ feeds: feedStore, gateway, importer, clock }),
  }),
);
app.route('/', apiKeyRoutes(keys));
app.route('/', ingestRoutes({ keys, ingest }));
app.notFound((c) => c.json({ detail: 'Not Found' }, 404));
app.onError((error, c) => c.json({ detail: 'Internal Server Error' }, 500));

const json = (value) => JSON.stringify(value);
const long = (n, unit = 'x') => unit.repeat(n);
const feed = (extra) =>
  json({ name: 'Diario', url: 'https://diario.example/rss', authorization_note: 'Nota', ...extra });
const W = `Bearer mscli_aaaaaaaaaaaa_${SECRET}`;
const R = `Bearer mscli_bbbbbbbbbbbb_${SECRET}`;
const P = `Bearer mscli_cccccccccccc_${SECRET}`;
const JSON_TYPE = { 'content-type': 'application/json' };
const FORM = { 'content-type': 'application/x-www-form-urlencoded' };
const signal = (extra) =>
  json({
    source_name: 'Fuente sintética',
    source_url: 'https://fuente.example/nota',
    external_id: 'ext-1',
    text: 'Texto sintético',
    observed_at: '2026-10-01T10:00:00Z',
    ...extra,
  });

const REQUESTS = [];
const add = (method, path, body, headers = JSON_TYPE) => REQUESTS.push({ method, path, headers, body });

// Media feeds: MediaFeedIn and the service's own URL rules.
const FEED_BODIES = [
  '',
  'no es json',
  'null',
  '[]',
  '{}',
  '"x"',
  feed({}),
  `\uFEFF${feed({})}`,
  feed({ name: '  Diario  ', keywords: [' agua ', 'agua', 'Agua'], territory: ' Costa ' }),
  feed({ name: '' }),
  feed({ name: '   ' }),
  feed({ name: long(120) }),
  feed({ name: long(121) }),
  feed({ name: long(120, '😀') }),
  feed({ name: long(121, '😀') }),
  feed({ name: 'a\u0000b' }),
  feed({ name: `${long(121)}\u0000` }),
  feed({ name: 5 }),
  feed({ name: null }),
  feed({ name: [] }),
  feed({ name: ['x'] }),
  feed({ name: { length: 3 } }),
  feed({ url: '' }),
  feed({ url: long(501) }),
  feed({ url: `https://diario.example/${long(480)}` }),
  feed({ url: 'no es url' }),
  feed({ url: 'http://diario.example/rss' }),
  feed({ url: 'ftp://diario.example/rss' }),
  feed({ url: 'javascript:alert(1)' }),
  feed({ url: 'https://user:pw@diario.example/rss' }),
  feed({ url: 'https://user@diario.example/rss' }),
  feed({ url: 'https://diario.example:8443/rss' }),
  feed({ url: 'https://diario.example:443/rss' }),
  feed({ url: 'https://127.0.0.1/rss' }),
  feed({ url: 'https://0x7f000001/rss' }),
  feed({ url: 'https://2130706433/rss' }),
  feed({ url: 'https://127.1/rss' }),
  feed({ url: 'https://[::1]/rss' }),
  feed({ url: 'https://[::ffff:127.0.0.1]/rss' }),
  feed({ url: 'https://localhost/rss' }),
  feed({ url: 'https://localhost./rss' }),
  feed({ url: 'https://intranet/rss' }),
  feed({ url: 'https://router.local/rss' }),
  feed({ url: 'https://a.LOCALHOST/rss' }),
  feed({ url: 'https://svc.internal/rss' }),
  feed({ url: 'https://x.lan/rss' }),
  feed({ url: 'https://x.home/rss' }),
  feed({ url: 'https://x.corp/rss' }),
  feed({ url: 'https://x.intranet/rss' }),
  feed({ url: 'HTTPS://Diario.EXAMPLE/a/../b/./c?q=1 2#frag' }),
  feed({ url: 'https:diario.example/rss' }),
  feed({ url: 'https:\\\\diario.example\\rss' }),
  feed({ url: 'https://diario.example/ruta con espacio/ñ?x="y"&z=<1>' }),
  feed({ url: '  https://diario.example/rss  ' }),
  feed({ url: 'https://dia\trio.example/rss' }),
  feed({ url: 'https://di%61rio.example/rss' }),
  feed({ url: 'https://diario.example' }),
  feed({ url: 'https://diario.example?' }),
  feed({ url: 'https://diario.example/#' }),
  feed({ url: 'https://diario.example/%2e%2E/x' }),
  feed({ url: 'https://diario..example/rss' }),
  feed({ url: 'https://dia rio.example/rss' }),
  feed({ url: 'https://diario.example:/rss' }),
  feed({ url: 'https://diario.example:99999/rss' }),
  feed({ url: 'https://diario.example:12a/rss' }),
  feed({ url: 'https://@diario.example/rss' }),
  feed({ url: 'https://diario.example/rss`{}' }),
  feed({ url: 'https://duplicada.example/rss' }),
  feed({ keywords: 'agua' }),
  feed({ keywords: [] }),
  feed({ keywords: null }),
  feed({ keywords: [''] }),
  feed({ keywords: ['  '] }),
  feed({ keywords: [long(60)] }),
  feed({ keywords: [long(61)] }),
  feed({ keywords: [5, 'x', null] }),
  feed({ keywords: Array.from({ length: 30 }, (_, i) => `k${i}`) }),
  feed({ keywords: Array.from({ length: 31 }, (_, i) => `k${i}`) }),
  feed({ keywords: Array.from({ length: 31 }, () => 5) }),
  feed({ territory: long(201) }),
  feed({ territory: null }),
  feed({ authorization_note: '' }),
  feed({ authorization_note: ' ' }),
  feed({ authorization_note: long(1001) }),
  feed({ authorization_note: undefined }),
  feed({ enabled: false }),
  feed({ enabled: 'true' }),
  feed({ enabled: null }),
  feed({ name: 'LLENO' }),
  json({ name: 1, url: 2, keywords: 3, territory: 4, authorization_note: 5, enabled: 6 }),
  feed({ extra: 1, project_id: 'PRJ-SECHURA' }),
];
for (const body of FEED_BODIES) add('POST', '/system/v4/media/feeds', body);
for (const id of ['7', '404', '0', '-1', '1.5', '2147483648', 'abc', '0x7', '1e1', '%37', '07', '%207'])
  add('PUT', `/system/v4/media/feeds/${id}`, feed({}));
add('PUT', '/system/v4/media/feeds/7', feed({ url: 'https://duplicada.example/rss' }));
add('PUT', '/system/v4/media/feeds/7', feed({ url: 'http://x.example/' }));
add('PUT', '/system/v4/media/feeds/404', feed({ url: 'http://x.example/' }));
add('PUT', '/system/v4/media/feeds/abc', 'no es json');
add('PUT', '/system/v4/media/feeds/7', feed({ enabled: false, name: 'Pausada' }));
for (const id of ['7', '404', '0', 'abc', '2147483647', '2147483648', '%207'])
  add('DELETE', `/system/v4/media/feeds/${id}`, undefined, {});
for (const body of [
  json({ url: 'https://diario.example/rss' }),
  json({ url: 'https://diario.example/rss', keywords: ['agua', 'MINERÍA', 'nada', 'Contaminación'] }),
  json({ url: ' https://diario.example/rss ', keywords: [' agua '] }),
  json({ url: 'https://error-timeout.example/rss' }),
  json({ url: 'https://error-redirect.example/rss' }),
  json({ url: 'https://error-blocked_address.example/rss' }),
  json({ url: 'https://error-other.example/rss' }),
  json({ url: 'https://error-weird_code.example/rss' }),
  json({ url: 'http://diario.example/rss' }),
  json({ url: 'https://localhost/rss' }),
  json({ url: '' }),
  json({ url: long(501) }),
  json({ url: 'https://diario.example/rss', keywords: Array.from({ length: 31 }, () => 'k') }),
  json({ url: 'https://diario.example/rss', keywords: [long(61)] }),
  json({ url: 'https://diario.example/rss', keywords: [''] }),
  json({}),
  'no es json',
])
  add('POST', '/system/v4/media/preview', body);
add('POST', '/system/v4/media/poll', undefined, {});
add('POST', '/system/v4/media/feeds', json({ name: long(9000) }));

// Authorized sources (Defensoría): preview, configuration and import.
for (const query of ['', 'agua', 'falla', 'vacia', long(100), long(101), 'a%00b', '%F0%9F%98%80'])
  add('GET', `/system/intelligence/sources/defensoria/preview?query=${query}`, undefined, {});
add('GET', '/system/intelligence/sources/defensoria/preview', undefined, {});
for (const body of [
  json({ enabled: true, authorization_note: 'Convenio', query: ' agua ', territory: 'Costa' }),
  json({ enabled: true }),
  json({ enabled: true, authorization_note: '   ' }),
  json({ enabled: false }),
  json({ enabled: 'si' }),
  json({}),
  json({ enabled: true, authorization_note: 'Nota', query: long(101) }),
  json({ enabled: true, authorization_note: 'Nota', query: 'a\u0000' }),
  json({ enabled: true, authorization_note: long(1001), territory: long(201) }),
  json({ enabled: false, query: 5 }),
  'no es json',
  'null',
])
  add('PUT', '/system/intelligence/sources/defensoria/config', body);
for (const body of [
  json({ post_id: 101 }),
  json({ post_id: 101, territory: ' Costa ' }),
  json({ post_id: 101, territory: 'repetida' }),
  json({ post_id: 101, territory: 'colision' }),
  json({ post_id: 101, territory: '' }),
  json({ post_id: 2147483647 }),
  json({ post_id: 2147483648 }),
  json({ post_id: 5 }),
  json({ post_id: 0 }),
  json({ post_id: -3 }),
  json({ post_id: 1.5 }),
  json({ post_id: '101' }),
  json({ post_id: null }),
  json({}),
  json({ post_id: 101, territory: long(201) }),
  json({ post_id: 101, territory: 7 }),
  '{"post_id":1e400}',
  'no es json',
])
  add('POST', '/system/intelligence/sources/defensoria/import', body);
add('POST', '/system/intelligence/sources/defensoria/poll', undefined, {});
add('PUT', '/system/intelligence/sources/defensoria/config', json({ query: long(9000) }));

// API key revocation.
for (const id of ['12', '13', '0012', 'abc', '1234567890', '%31%32', '-1'])
  add('DELETE', `/system/integrations/api-keys/${id}`, undefined, {});

// Signals: SignalIn, its fingerprint and the idempotency key derived from it.
const SIGNALS = [
  signal({}),
  signal({ territory: 'Costa' }),
  signal({ territory: '  ' }),
  signal({ source_name: '  Fuente  ', text: ' Texto ' }),
  signal({ source_url: ' https://fuente.example/a\tb ' }),
  signal({ source_url: 'https://fuente.example/ruta con espacio' }),
  signal({ source_url: 'HTTP://FUENTE.example' }),
  signal({ source_url: 'ftp://fuente.example/x' }),
  signal({ source_url: 'https://u:p@fuente.example/x' }),
  signal({ source_url: 'https://u@fuente.example/x' }),
  signal({ source_url: 'mailto:a@b.example' }),
  signal({ source_url: 'no es url' }),
  signal({ source_url: `https://fuente.example/${long(2000)}` }),
  signal({ observed_at: '2026-10-01T10:00:00.123456+05:30' }),
  signal({ observed_at: '2026-10-01T10:00:00-03:00' }),
  signal({ observed_at: '2026-10-01T10:00Z' }),
  signal({ observed_at: '2026-10-01T10:00:00' }),
  signal({ observed_at: '2026-02-30T10:00:00Z' }),
  signal({ observed_at: '2024-02-29T23:59:59.9Z' }),
  signal({ observed_at: '2026-10-01T24:00:00Z' }),
  signal({ observed_at: '2026-10-01 10:00:00Z' }),
  signal({ external_id: long(201) }),
  signal({ external_id: 'a\u0000' }),
  signal({ text: long(20001) }),
  signal({ text: '😀'.repeat(10000) }),
  signal({ source_name: long(101) }),
  signal({ territory: long(201) }),
  signal({ text: 5 }),
  json({}),
  'null',
  'no es json',
  '[]',
];
for (const body of SIGNALS) add('POST', '/hooks/signals', body, { ...JSON_TYPE, authorization: W });
add('POST', '/hooks/signals', signal({}), { ...JSON_TYPE, authorization: W, 'idempotency-key': 'k-1' });
add('POST', '/hooks/signals', signal({}), { ...JSON_TYPE, authorization: W, 'idempotency-key': 'con espacio' });
add('POST', '/hooks/signals', signal({}), { ...JSON_TYPE, authorization: W, 'idempotency-key': 'repetida' });
add('POST', '/hooks/signals', 'no es json', { ...JSON_TYPE, authorization: W, 'idempotency-key': 'con espacio' });
add('POST', '/hooks/signals', signal({}), { ...JSON_TYPE, authorization: R });
add('POST', '/hooks/signals', signal({}), { ...JSON_TYPE });
add('POST', '/hooks/signals', signal({}), { 'content-type': 'text/plain', authorization: W });
add('POST', '/hooks/signals', '@repeat:70000', { ...JSON_TYPE, authorization: W });

// Ingest: credentials, idempotency keys, media types and bodies (the fake echoes what it got).
const ingestCase = (body, headers, path = '/hooks/ingest/narrativas') =>
  add('POST', path, body, { ...JSON_TYPE, authorization: W, ...headers });
for (const authorization of [
  W,
  R,
  P,
  '',
  'Bearer',
  'Bearer ',
  `bearer mscli_aaaaaaaaaaaa_${SECRET}`,
  `Bearer  mscli_aaaaaaaaaaaa_${SECRET} `,
  `Bearer mscli_aaaaaaaaaaaa_${SECRET}x`,
  `Bearer mscli_AAAAAAAAAAAA_${SECRET}`,
  `Basic mscli_aaaaaaaaaaaa_${SECRET}`,
  `Bearer mscli_dddddddddddd_${SECRET}`,
])
  ingestCase(json({ Descripcion: 'x' }), { authorization });
ingestCase(json({ Descripcion: 'x' }), { authorization: undefined });
for (const key of ['k', 'con espacio', long(200), long(201), 'ñ', '!~', 'repetida', ''])
  ingestCase(json({ Descripcion: 'x' }), { 'idempotency-key': key });
ingestCase(json({ Descripcion: 'x' }), { 'webhook-id': 'msg_1' });
ingestCase(json({ Descripcion: 'x' }), { 'webhook-id': 'con espacio' });
ingestCase(json({ Descripcion: 'x' }), { 'idempotency-key': 'a', 'webhook-id': 'b' });
for (const body of [
  json({ Descripcion: 'x', '10': 'diez', 2: 'dos', __proto__: 1 }),
  '{"__proto__":{"x":1},"b":1,"a":2,"b":3}',
  json([{ a: 1 }, { b: 2 }]),
  json({ records: [{ a: 1 }] }),
  json({ records: [{ a: 1 }], otro: 1 }),
  json({ records: 'x' }),
  json([]),
  'null',
  '5',
  '"texto"',
  '1e400',
  '{"a":1e400,"b":-0,"c":0.1,"d":123456789012345678901}',
  '\uFEFF{"a":1}',
  'no es json',
  '',
  '{"a":"\\ud800"}',
])
  ingestCase(body, {});
ingestCase(json({ a: 1 }), {}, '/hooks/ingest/parcial');
ingestCase(json({ a: 1 }), {}, '/hooks/ingest/%6E%61rrativas');
ingestCase(json({ a: 1 }), {}, '/hooks/ingest/Narrativas');
for (const type of [
  'application/json; charset=utf-8',
  'Application/JSON',
  'application/jsonx',
  'text/plain',
  'application/xml',
  '',
])
  ingestCase(json({ a: 1 }), { 'content-type': type });
for (const [type, body] of [
  [FORM['content-type'], 'Descripcion=Texto+sint%C3%A9tico&Territorio=Costa&Descripcion=Otra'],
  [FORM['content-type'], 'a=1&b&=vacio&c=%ZZ&d=%E2%82&e=x%2By&f[]=1&f[]=2&10=diez&__proto__=p'],
  [`${FORM['content-type']}; charset=utf-8`, 'a=1'],
  ['APPLICATION/X-WWW-FORM-URLENCODED', 'a=1'],
  ['application/x-www-form-urlencodedx', 'a=1'],
  [FORM['content-type'], ''],
  [FORM['content-type'], '&&;a=1;b=2'],
  [
    'multipart/form-data; boundary=XyZ',
    '--XyZ\r\nContent-Disposition: form-data; name="Descripcion"\r\n\r\nTexto multiparte\r\n--XyZ\r\nContent-Disposition: form-data; name="archivo"; filename="a.txt"\r\nContent-Type: text/plain\r\n\r\ncontenido\r\n--XyZ\r\nContent-Disposition: form-data; name="Territorio"\r\n\r\nCosta\r\n--XyZ--\r\n',
  ],
  [
    'multipart/form-data; boundary=XyZ',
    '--XyZ\r\nContent-Disposition: form-data; name="a"\r\n\r\n1\r\n--XyZ\r\nContent-Disposition: form-data; name="a"; filename="a.txt"\r\n\r\nfile\r\n--XyZ--\r\n',
  ],
  ['multipart/form-data', '--XyZ\r\n'],
  ['multipart/form-data; boundary=XyZ', 'sin partes'],
])
  ingestCase(body, { 'content-type': type });
ingestCase('@repeat:614400', {});
add('POST', '/hooks/ingest/narrativas', '@repeat:614400', { ...JSON_TYPE });
add('GET', '/hooks/ingest/narrativas', undefined, { authorization: W });

/** `@repeat:<n>` is {"a": "x" repeated n times}, kept short in the fixture. */
export const expand = (body) =>
  body.startsWith('@repeat:') ? json({ a: long(Number(body.slice(8))) }) : body;

const cases = [];
for (const r of REQUESTS) {
  captured.length = 0;
  const headers = Object.fromEntries(
    Object.entries(r.headers).filter(([, v]) => v !== undefined),
  );
  const response = await app.request(`http://parity.invalid${r.path}`, {
    method: r.method,
    headers,
    ...(r.body === undefined ? {} : { body: expand(r.body) }),
  });
  const text = await response.text();
  cases.push({
    method: r.method,
    path: r.path,
    headers,
    body: r.body ?? null,
    status: response.status,
    response: text,
    www_authenticate: response.headers.get('www-authenticate'),
    replayed: response.headers.get('idempotent-replayed'),
    captured: captured.map((c) => ({ id: c.id, payload: JSON.stringify(c.payload) })),
  });
}

const text = await format(JSON.stringify({ now: NOW.toISOString(), cases }), {
  ...(await resolveConfig(OUT)),
  filepath: OUT,
});
if (process.argv.includes('--check')) {
  if (readFileSync(OUT, 'utf8') !== text) {
    console.error('routes.json drifted from the TypeScript routes; rerun without --check');
    process.exit(1);
  }
} else {
  writeFileSync(OUT, text);
}
