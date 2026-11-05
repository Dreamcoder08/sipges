// Records the TypeScript tenancy routes' answers on synthetic requests, for the Go port's pinned
// test (../http/fixtures_test.go). The real routes and service run over an in-memory store, so
// the fixture holds every status, body, header and stored row the TypeScript API produces.
// Run from the repository root after changing either side:
//
//   node apps/api-go/internal/tenancy/testdata/generate.mjs          # rewrites the fixture
//   node apps/api-go/internal/tenancy/testdata/generate.mjs --check  # exit 1 when it drifted
//
// Every value is synthetic: no real account, project or record is read.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { format, resolveConfig } from 'prettier';
import { Hono } from '../../../../api/node_modules/hono/dist/index.js';
import { createTenancyService } from '../../../../api/src/contexts/tenancy/application/tenancy-service.ts';
import { tenancyRoutes } from '../../../../api/src/contexts/tenancy/http/tenancy-routes.ts';

const OUT = fileURLToPath(new URL('./fixtures.json', import.meta.url));
const AT = new Date('2026-01-02T03:04:05.678Z');

const USERS = ['admin', 'ana.perez', 'luis.diaz', 'x'.repeat(120), '\u{1F600}'.repeat(60)];
const SESSIONS = {
  'admin-token': { username: 'admin', role: 'admin' },
  'ana-token': { username: 'ana.perez', role: 'analista' },
};

/** The starting rows of every case: the default project, a second one and their grants. */
const initialState = () => ({
  tenants: [
    { company_id: 'SIPGES', project_id: 'PRJ-SECHURA', label: 'Proyecto Sechura (migración)' },
    { company_id: 'ACME', project_id: 'EXISTE', label: '<b>"Acme" & \'Co\'</b>' },
  ],
  grants: [
    { username: 'admin', tenant_id: 'SIPGES/PRJ-SECHURA' },
    { username: 'admin', tenant_id: 'ACME/EXISTE' },
    { username: 'ana.perez', tenant_id: 'ACME/EXISTE' },
  ],
});

const memoryStore = (state) => {
  const tenantId = (s) => `${s.companyId}/${s.projectId}`;
  const find = (s) =>
    state.tenants.find((t) => t.company_id === s.companyId && t.project_id === s.projectId);
  const hasGrant = (username, id) =>
    state.grants.some((g) => g.username === username && g.tenant_id === id);
  return {
    async ensureTenant() {},
    async createTenantWithGrant(scope, label, username) {
      if (find(scope)) return false;
      state.tenants.push({ company_id: scope.companyId, project_id: scope.projectId, label });
      state.grants.push({ username, tenant_id: tenantId(scope) });
      return true;
    },
    async tenantExists(scope) {
      return find(scope) !== undefined;
    },
    async tenantLabel(scope) {
      return find(scope)?.label ?? null;
    },
    async grant(username, scope) {
      if (!hasGrant(username, tenantId(scope)))
        state.grants.push({ username, tenant_id: tenantId(scope) });
    },
    async revoke(username, scope) {
      const index = state.grants.findIndex(
        (g) => g.username === username && g.tenant_id === tenantId(scope),
      );
      if (index < 0) return false;
      state.grants.splice(index, 1);
      return true;
    },
    async listGrants(username) {
      return state.grants
        .filter((g) => g.username === username)
        .map((g) => state.tenants.find((t) => `${t.company_id}/${t.project_id}` === g.tenant_id))
        .filter(Boolean)
        .sort((a, b) =>
          a.company_id === b.company_id
            ? a.project_id < b.project_id
              ? -1
              : 1
            : a.company_id < b.company_id
              ? -1
              : 1,
        )
        .map((t) => ({ companyId: t.company_id, projectId: t.project_id, label: t.label }));
    },
  };
};

const appFor = (state) => {
  const tenancy = createTenancyService({
    store: memoryStore(state),
    users: { exists: async (u) => USERS.includes(u), adminUsernames: async () => ['admin'] },
    clock: { now: () => AT },
    dataReader: { read: async () => ({}) },
  });
  const identity = { authenticate: async (token) => SESSIONS[token] ?? null };
  const app = new Hono();
  // Stands in for the session middleware: the actor of the case.
  app.use('*', async (c, next) => {
    const actor = c.req.header('x-test-actor');
    if (actor) c.set('identity', SESSIONS[actor]);
    await next();
  });
  app.route('/', tenancyRoutes({ tenancy, identity, cookieSecure: true }));
  return app;
};

const enc = (text) => Buffer.from(text, 'utf8');
const json = (value) => enc(JSON.stringify(value));
const grant = { username: 'ana.perez', company_id: 'SIPGES', project_id: 'PRJ-SECHURA' };
const scope = {
  company_id: 'ACME',
  project_id: 'NORTE',
  label: 'Proyecto Norte',
  username: 'ana.perez',
};
const deepArray = enc(`${'['.repeat(20_000)}${']'.repeat(20_000)}`);
const deepField = enc(
  `{"username":${'['.repeat(20_000)}${']'.repeat(20_000)},"company_id":"SIPGES","project_id":"PRJ-SECHURA"}`,
);

/** Bodies every JSON route answers: syntax, shape and type errors before any rule. */
const jsonBodies = (valid) => [
  ['valid', json(valid)],
  ['empty body', enc('')],
  ['whitespace only', enc(' \n\t ')],
  ['not JSON', enc('username=admin')],
  ['truncated', enc('{"username":')],
  ['trailing data', enc('{} x')],
  ['two documents', enc('{}{}')],
  ['trailing whitespace', enc(`${JSON.stringify(valid)} \r\n`)],
  ['byte order mark', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), json(valid)])],
  ['null', enc('null')],
  ['array', enc('[]')],
  ['string', enc('"text"')],
  ['number', enc('1')],
  ['infinite number', enc('1e400')],
  ['negative infinite number', enc('-1e400')],
  ['tiny number', enc('1e-400')],
  ['boolean', enc('true')],
  ['empty object', enc('{}')],
  ['single quotes', enc("{'username':'admin'}")],
  ['leading zero', enc('{"username":01}')],
  ['raw control character', enc('{"username":"a\tb"}')],
  ['bad escape', enc('{"username":"\\x41"}')],
  ['nesting deeper than 10000', deepArray],
  ['deep value in a field', deepField],
  ...Object.keys(valid).flatMap((field) => [
    [`missing ${field}`, json({ ...valid, [field]: undefined })],
    [`${field} null`, json({ ...valid, [field]: null })],
    [`${field} number`, json({ ...valid, [field]: 7 })],
    [
      `${field} infinite`,
      enc(JSON.stringify({ ...valid, [field]: 0 }).replace(`"${field}":0`, `"${field}":1e400`)),
    ],
    [`${field} boolean`, json({ ...valid, [field]: false })],
    [`${field} object`, json({ ...valid, [field]: {} })],
    [`${field} array`, json({ ...valid, [field]: ['a'] })],
    [`${field} NUL`, json({ ...valid, [field]: `${valid[field]}\u0000` })],
    [`${field} empty`, json({ ...valid, [field]: '' })],
    [`${field} 120 units`, json({ ...valid, [field]: 'y'.repeat(120) })],
    [`${field} 121 units`, json({ ...valid, [field]: 'y'.repeat(121) })],
    [`${field} 60 astral`, json({ ...valid, [field]: '\u{1F600}'.repeat(60) })],
    [`${field} 61 astral`, json({ ...valid, [field]: '\u{1F600}'.repeat(61) })],
  ]),
  ['NUL and a missing field', json({ ...valid, username: undefined, company_id: 'A\u0000' })],
  ['NUL and a wrong type', json({ ...valid, username: 1, company_id: 'A\u0000' })],
  ['two wrong types', json({ ...valid, username: 1, company_id: null })],
  ['extra fields', json({ ...valid, extra: 1, role: 'admin' })],
  [
    'duplicate key, last wins',
    enc(`${JSON.stringify(valid).slice(0, -1)},"username":"luis.diaz"}`),
  ],
  ['__proto__ key', enc(`{"__proto__":{"username":"admin"},${JSON.stringify(valid).slice(1)}`)],
  ['lone surrogate escape', enc(JSON.stringify(valid).replace('"ana.perez"', '"ana\\ud800"'))],
  ['escaped username', enc(JSON.stringify(valid).replace('"ana.perez"', '"\\u0061na.perez"'))],
  ...[
    ['truncated', [0xf0, 0x9f, 0x98]],
    ['overlong', [0xc0, 0xaf]],
    ['surrogate', [0xed, 0xa0, 0x80]],
    ['lone continuation', [0x80, 0x80]],
    ['E0 then 80', [0xe0, 0x80]],
  ].map(([kind, bytes]) => [
    `invalid UTF-8 in a string (${kind})`,
    Buffer.concat([
      enc('{"username":"ana'),
      Buffer.from(bytes),
      enc(`",${JSON.stringify({ ...valid, username: undefined }).slice(1)}`),
    ]),
  ]),
  ['invalid UTF-8 outside a string', Buffer.concat([json(valid), Buffer.from([0xff])])],
  ['username 120 units', json({ ...valid, username: 'x'.repeat(120) })],
  ['username 60 astral', json({ ...valid, username: '\u{1F600}'.repeat(60) })],
];

const CASES = [];
const add = (name, request) => CASES.push({ name, ...request });

for (const [method, path, valid] of [
  ['POST', '/system/auth/grants', grant],
  ['DELETE', '/system/auth/grants', { ...grant, project_id: 'EXISTE', company_id: 'ACME' }],
  ['POST', '/system/auth/scopes', scope],
]) {
  for (const [label, body] of jsonBodies(valid)) {
    add(`${method} ${path} admin ${label}`, { method, path, actor: 'admin-token', body });
  }
  add(`${method} ${path} analyst valid`, { method, path, actor: 'ana-token', body: json(valid) });
  add(`${method} ${path} analyst invalid`, { method, path, actor: 'ana-token', body: enc('[]') });
  add(`${method} ${path} text/plain`, {
    method,
    path,
    actor: 'admin-token',
    contentType: 'text/plain',
    body: json(valid),
  });
  add(`${method} ${path} no content type`, {
    method,
    path,
    actor: 'admin-token',
    contentType: '',
    body: json(valid),
  });
}

const grantCases = [
  ['user missing', { ...grant, username: 'nobody' }],
  ['tenant missing', { ...grant, company_id: 'NO', project_id: 'PE' }],
  ['tenant of another company', { ...grant, company_id: 'ACME', project_id: 'EXISTE' }],
  ['repeated grant', { username: 'admin', company_id: 'ACME', project_id: 'EXISTE' }],
  ['slash in the company', { ...grant, company_id: 'SIPGES/PRJ', project_id: 'SECHURA' }],
  ['case differs', { ...grant, company_id: 'sipges' }],
  ['padded username', { ...grant, username: ' ana.perez' }],
];
for (const [label, body] of grantCases) {
  add(`POST grants ${label}`, {
    method: 'POST',
    path: '/system/auth/grants',
    actor: 'admin-token',
    body: json(body),
  });
  add(`DELETE grants ${label}`, {
    method: 'DELETE',
    path: '/system/auth/grants',
    actor: 'admin-token',
    body: json(body),
  });
}
add('DELETE grants absent grant', {
  method: 'DELETE',
  path: '/system/auth/grants',
  actor: 'admin-token',
  body: json({ username: 'luis.diaz', company_id: 'ACME', project_id: 'EXISTE' }),
});

const scopeCases = [
  ['one-character company', { ...scope, company_id: 'A' }],
  ['65-character project', { ...scope, project_id: 'P'.repeat(65) }],
  ['64-character project', { ...scope, project_id: 'P'.repeat(64) }],
  ['space in project', { ...scope, project_id: 'has space' }],
  ['accented company', { ...scope, company_id: 'ÁCME' }],
  ['newline after company', { ...scope, company_id: 'ACME\n' }],
  ['slash in company', { ...scope, company_id: 'AC/ME' }],
  ['reserved default', { ...scope, company_id: 'SIPGES', project_id: 'PRJ-SECHURA' }],
  ['reserved, other case', { ...scope, company_id: 'sipges', project_id: 'PRJ-SECHURA' }],
  ['existing project', { ...scope, project_id: 'EXISTE', label: 'Otro' }],
  ['user missing', { ...scope, username: 'nobody' }],
  ['invalid ids and missing user', { ...scope, company_id: 'A', username: 'nobody' }],
  [
    'reserved and missing user',
    { ...scope, company_id: 'SIPGES', project_id: 'PRJ-SECHURA', username: 'nobody' },
  ],
  ['label of 130 characters', { ...scope, label: 'L'.repeat(130) }],
  ['label cut inside an astral character', { ...scope, label: `${'L'.repeat(119)}\u{1F600}tail` }],
  ['empty label', { ...scope, label: '' }],
  ['label with markup', { ...scope, label: '<script>alert(1)</script>' }],
  ['underscores and dashes', { ...scope, company_id: 'A_-', project_id: '-_9' }],
  ['grant to the admin', { ...scope, username: 'admin' }],
];
for (const [label, body] of scopeCases) {
  add(`POST scopes ${label}`, {
    method: 'POST',
    path: '/system/auth/scopes',
    actor: 'admin-token',
    body: json(body),
  });
}

add('GET scopes admin', { method: 'GET', path: '/system/auth/scopes', actor: 'admin-token' });
add('GET scopes analyst', { method: 'GET', path: '/system/auth/scopes', actor: 'ana-token' });
add('HEAD scopes admin', { method: 'HEAD', path: '/system/auth/scopes', actor: 'admin-token' });

const form = (text) => ({ contentType: 'application/x-www-form-urlencoded', body: enc(text) });
const multipart = (parts) => {
  const boundary = 'parity-boundary';
  const text = parts
    .map(
      ([name, value, filename]) =>
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"${filename !== undefined ? `; filename="${filename}"\r\nContent-Type: text/plain` : ''}\r\n\r\n${value}\r\n`,
    )
    .join('');
  return {
    contentType: `multipart/form-data; boundary=${boundary}`,
    body: enc(`${text}--${boundary}--\r\n`),
  };
};
const select = (name, cookie, request) =>
  add(`select-project ${name}`, { method: 'POST', path: '/select-project', cookie, ...request });

add('GET select-project anonymous', { method: 'GET', path: '/select-project' });
add('GET select-project unknown session', {
  method: 'GET',
  path: '/select-project',
  cookie: 'sipges_session=nope',
});
add('GET select-project admin', {
  method: 'GET',
  path: '/select-project',
  cookie: 'sipges_session=admin-token',
});
add('GET select-project analyst', {
  method: 'GET',
  path: '/select-project',
  cookie: 'sipges_session=ana-token',
});
add('HEAD select-project admin', {
  method: 'HEAD',
  path: '/select-project',
  cookie: 'sipges_session=admin-token',
});
const admin = 'sipges_session=admin-token';
select('anonymous', undefined, form('scope=SIPGES%2FPRJ-SECHURA'));
select('unknown session', 'sipges_session=nope', form('scope=SIPGES%2FPRJ-SECHURA'));
select('granted', admin, form('scope=SIPGES%2FPRJ-SECHURA'));
select('granted, raw slash', admin, form('scope=ACME/EXISTE'));
select('not granted', admin, form('scope=EVIL%2FCORP'));
select(
  'granted to another user only',
  'sipges_session=ana-token',
  form('scope=SIPGES%2FPRJ-SECHURA'),
);
select('missing scope', admin, form('other=1'));
select('empty body', admin, form(''));
select('empty scope', admin, form('scope='));
select('repeated key, last wins', admin, form('scope=EVIL%2FCORP&scope=ACME%2FEXISTE'));
select('repeated key, last not granted', admin, form('scope=ACME%2FEXISTE&scope=EVIL'));
select('plus as space', admin, form('scope=ACME+%2FEXISTE'));
select('invalid percent escape', admin, form('scope=ACME%zz%2FEXISTE'));
select('semicolon is not a separator', admin, form('scope=ACME%2FEXISTE;x=1'));
select('empty pairs', admin, form('&&scope=ACME%2FEXISTE&&'));
select('key without value', admin, form('scope'));
select('encoded key', admin, form('%73cope=ACME%2FEXISTE'));
select('invalid UTF-8', admin, {
  contentType: 'application/x-www-form-urlencoded',
  body: Buffer.concat([enc('scope=ACME%2F'), Buffer.from([0xff])]),
});
select('upper-case media type', admin, {
  ...form('scope=ACME%2FEXISTE'),
  contentType: 'Application/X-WWW-Form-Urlencoded; charset=latin1',
});
select('JSON body', admin, {
  contentType: 'application/json',
  body: json({ scope: 'ACME/EXISTE' }),
});
select('no content type', admin, { contentType: '', body: enc('scope=ACME%2FEXISTE') });
select('text/plain', admin, { contentType: 'text/plain', body: enc('scope=ACME%2FEXISTE') });
select('multipart granted', admin, multipart([['scope', 'ACME/EXISTE']]));
select('multipart file only', admin, multipart([['scope', 'ACME/EXISTE', 'scope.txt']]));
select(
  'multipart file then field',
  admin,
  multipart([
    ['scope', 'EVIL', 'a.txt'],
    ['scope', 'ACME/EXISTE'],
  ]),
);
select(
  'multipart field then file',
  admin,
  multipart([
    ['scope', 'ACME/EXISTE'],
    ['scope', 'x', 'a.txt'],
  ]),
);
select('multipart empty filename', admin, multipart([['scope', 'ACME/EXISTE', '']]));
select('multipart without boundary', admin, {
  contentType: 'multipart/form-data',
  body: enc('scope=ACME'),
});
select('multipart malformed', admin, {
  contentType: 'multipart/form-data; boundary=zz',
  body: enc('garbage'),
});

const b64 = (buffer) => (buffer ? Buffer.from(buffer).toString('base64') : undefined);

const record = async () => {
  const out = [];
  for (const c of CASES) {
    const state = initialState();
    const app = appFor(state);
    const headers = {};
    if (c.actor) headers['x-test-actor'] = c.actor;
    if (c.cookie) headers.cookie = c.cookie;
    if (c.body !== undefined && c.contentType !== '')
      headers['content-type'] = c.contentType ?? 'application/json';
    const res = await app.request(c.path, { method: c.method, headers, body: c.body });
    out.push({
      name: c.name,
      method: c.method,
      path: c.path,
      actor: c.actor ? SESSIONS[c.actor].username : undefined,
      cookie: c.cookie,
      contentType: headers['content-type'],
      body: b64(c.body),
      want: {
        status: res.status,
        contentType: res.headers.get('content-type') ?? '',
        location: res.headers.get('location') ?? '',
        setCookie: res.headers.get('set-cookie') ?? '',
        body: await res.text(),
        state,
      },
    });
  }
  return out;
};

// Formatted as `pnpm lint` (prettier --check) expects.
const text = await format(JSON.stringify(await record()), {
  ...(await resolveConfig(OUT)),
  filepath: OUT,
});
if (process.argv.includes('--check')) {
  if (readFileSync(OUT, 'utf8') !== text) {
    console.error(`${OUT} is out of date; run this script without --check`);
    process.exit(1);
  }
} else {
  writeFileSync(OUT, text);
}
