// Records the TypeScript records write routes' answers on synthetic requests, for the Go port's
// pinned test (../http/writes_fixtures_test.go). Each request runs through the real
// recordsRoutes and createRecordsService (apps/api/src/contexts/records) with a fixed clock, a
// counting randomHex and an in-memory store that logs every call the SQL store would turn into a
// statement: the candidate ids tried with the payload text each would store, the replaced
// payloads, the ids looked up, the import items and the audit notes. Run from the repository
// root after changing either side:
//
//   node apps/api-go/internal/records/testdata/writes.mjs          # rewrites writes.json
//   node apps/api-go/internal/records/testdata/writes.mjs --check  # exit 1 when it drifted
//
// Every payload is synthetic: no real record is read.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { format, resolveConfig } from 'prettier';
import { createRecordsService } from '../../../../api/src/contexts/records/application/records-service.ts';
import { recordsRoutes } from '../../../../api/src/contexts/records/http/records-routes.ts';

const OUT = fileURLToPath(new URL('./writes.json', import.meta.url));
const AT = '2026-11-03T12:00:00.123Z';

/** The store of ports.ts in memory; `log` holds what each call would write. */
const memoryStore = (existing, log) => {
  const rows = new Map(existing.map(([module, id]) => [`${module}\u0000${id}`, true]));
  const key = (module, id) => `${module}\u0000${id}`;
  const audit = (module, recordId, note, at) =>
    log.push({
      op: 'audit',
      module,
      recordId,
      action: note.action,
      detail: note.detail,
      at: at.toISOString(),
    });
  return {
    async create(_tenant, module, candidates, payloadFor, note, at) {
      for (const id of candidates) {
        const taken = rows.has(key(module, id));
        log.push({
          op: 'insert',
          module,
          id,
          payload: JSON.stringify(payloadFor(id)),
          taken,
          at: at.toISOString(),
        });
        if (taken) continue;
        rows.set(key(module, id), true);
        audit(module, id, note, at);
        return id;
      }
      return null;
    },
    async replace(_tenant, module, id, payload, note, at) {
      const found = rows.has(key(module, id));
      log.push({
        op: 'update',
        module,
        id,
        payload: JSON.stringify(payload),
        found,
        at: at.toISOString(),
      });
      if (found) audit(module, id, note, at);
      return found;
    },
    async remove(_tenant, module, id, note, at) {
      const found = rows.delete(key(module, id));
      log.push({ op: 'delete', module, id, found });
      if (found) audit(module, id, note, at);
      return found;
    },
    async existing(_tenant, module, ids) {
      log.push({ op: 'existing', module, ids: [...ids] });
      return new Set(ids.filter((id) => rows.has(key(module, id))));
    },
    async importBatch(_tenant, module, items, note, at) {
      log.push({
        op: 'import',
        module,
        items: JSON.stringify(items.map(({ id, payload }) => ({ id, payload }))),
        at: at.toISOString(),
      });
      let created = 0;
      let updated = 0;
      for (const { id } of items) {
        if (rows.has(key(module, id))) updated++;
        else {
          rows.set(key(module, id), true);
          created++;
        }
      }
      if (created + updated) audit(module, null, note, at);
      return { created, updated };
    },
    list: async () => [],
    get: async () => null,
    history: async () => [],
  };
};

/** A counting stand-in for crypto-random hex: 1, 2, 3, … left-padded with F. */
const countingHex = () => {
  let n = 0;
  return (length) => (++n).toString(16).toUpperCase().padStart(length, 'F').slice(-length);
};

const json = (value) => JSON.stringify(value);
const SECHURA = { companyId: 'SIPGES', projectId: 'PRJ-SECHURA' };
const BUZON = '/api/buzon';
const IMPORT = '/system/import/buzon';
const rows = (list, extra = {}) =>
  json({ rows: list, dry_run: false, source: 'hoja.xlsx', ...extra });

// [name, method, path, body text (or {bytes: hex}), existing [module, id] pairs, scope]
const SCENARIOS = [
  // Create: generated and chosen ids.
  ['create with a generated id', 'POST', BUZON, json({ payload: { Asunto: 'Consulta' } })],
  ['create with its id', 'POST', BUZON, json({ payload: { ID_Caso: 'BZ-7', Asunto: 'x' } })],
  ['create with a numeric id', 'POST', BUZON, '{"payload":{"ID_Caso":42.50}}'],
  ['create with an exponent id', 'POST', BUZON, '{"payload":{"ID_Caso":1e21}}'],
  ['create with a tiny id', 'POST', BUZON, '{"payload":{"ID_Caso":1e-7}}'],
  ['create with id zero', 'POST', BUZON, '{"payload":{"ID_Caso":0}}'],
  ['create with id minus zero', 'POST', BUZON, '{"payload":{"ID_Caso":-0}}'],
  ['create with an empty id', 'POST', BUZON, '{"payload":{"ID_Caso":""}}'],
  ['create with a null id', 'POST', BUZON, '{"payload":{"ID_Caso":null}}'],
  ['create with a boolean id', 'POST', BUZON, '{"payload":{"ID_Caso":true}}'],
  ['create with a false id', 'POST', BUZON, '{"payload":{"ID_Caso":false}}'],
  ['create with an object id', 'POST', BUZON, '{"payload":{"ID_Caso":{"a":1}}}'],
  ['create with an infinite id', 'POST', BUZON, '{"payload":{"ID_Caso":1e400}}'],
  ['create with a 200-unit id', 'POST', BUZON, json({ payload: { ID_Caso: 'I'.repeat(200) } })],
  ['create with a 201-unit id', 'POST', BUZON, json({ payload: { ID_Caso: 'I'.repeat(201) } })],
  ['create with 100 emoji', 'POST', BUZON, json({ payload: { ID_Caso: '😀'.repeat(100) } })],
  ['create with 101 emoji', 'POST', BUZON, json({ payload: { ID_Caso: '😀'.repeat(101) } })],
  [
    'create with a lone surrogate id',
    'POST',
    BUZON,
    '{"payload":{"ID_Caso":"X\\ud800Y","Asunto":"\\udc00"}}',
  ],
  [
    'create with a surrogate pair escape',
    'POST',
    BUZON,
    '{"payload":{"Asunto":"\\ud83d\\ude00 \\uD83D\\uDE00"}}',
  ],
  // Collisions: preferred, then five `<id>-<4 hex>` candidates.
  [
    'create on a taken id',
    'POST',
    BUZON,
    json({ payload: { ID_Caso: 'BZ-7' } }),
    [['Buzon', 'BZ-7']],
  ],
  [
    'create with every candidate taken',
    'POST',
    BUZON,
    json({ payload: { ID_Caso: 'BZ-7' } }),
    [
      ['Buzon', 'BZ-7'],
      ...['FFF1', 'FFF2', 'FFF3', 'FFF4', 'FFF5'].map((h) => ['Buzon', `BZ-7-${h}`]),
    ],
  ],
  [
    'create on a taken generated id',
    'POST',
    BUZON,
    json({ payload: {} }),
    [['Buzon', 'BZ-FFFFFFF1']],
  ],
  // Other modules: prefixes and id fields.
  ['create an event', 'POST', '/api/eventos', json({ payload: { Descripcion_Hecho: 'x' } })],
  ['create a commitment (no prefix)', 'POST', '/api/compromisos', json({ payload: {} })],
  [
    'create a directory entry (no id field)',
    'POST',
    '/api/directorio',
    json({ payload: { ID_Caso: 'ignorado' } }),
  ],
  [
    'create an indicator by code',
    'POST',
    '/api/indicadores',
    json({ payload: { Codigo: 'IND-1' } }),
  ],
  ['create an assessment', 'POST', '/api/aarc', json({ payload: { a: 1 } })],
  ['create a lesson', 'POST', '/api/lecciones', json({ payload: { ID_Leccion: '' } })],
  ['create a project', 'POST', '/api/proyectos', json({ payload: { Nombre: 'P' } })],
  [
    'create a project with its id',
    'POST',
    '/api/proyectos',
    json({ payload: { Proyecto_ID: 'PRJ-SECHURA' } }),
  ],
  [
    'create a project on a taken id',
    'POST',
    '/api/proyectos',
    json({ payload: { Proyecto_ID: 'PRJ-SECHURA' } }),
    [['Proyectos', 'PRJ-SECHURA']],
  ],
  ['create a user', 'POST', '/api/usuarios', json({ payload: { ID_Usuario: 'U1' } })],
  // The tenant's project.
  [
    'create naming its project',
    'POST',
    BUZON,
    json({ payload: { Proyecto_ID: 'PRJ-SECHURA', Asunto: 'x' } }),
  ],
  ['create naming another project', 'POST', BUZON, json({ payload: { Proyecto_ID: 'PRJ-OTRO' } })],
  [
    'create with an empty project',
    'POST',
    BUZON,
    json({ payload: { Asunto: 'x', Proyecto_ID: '', z: 1 } }),
  ],
  ['create with a numeric project', 'POST', BUZON, json({ payload: { Proyecto_ID: 5 } })],
  ['create with project zero', 'POST', BUZON, json({ payload: { Proyecto_ID: 0 } })],
  ['create with project false', 'POST', BUZON, json({ payload: { Proyecto_ID: false } })],
  [
    'create with a bad id and another project',
    'POST',
    BUZON,
    json({ payload: { ID_Caso: true, Proyecto_ID: 'X' } }),
  ],
  [
    'create in a scope without project',
    'POST',
    BUZON,
    json({ payload: { a: 1 } }),
    [],
    { companyId: 'ACME', projectId: '' },
  ],
  [
    'create in a nested scope',
    'POST',
    BUZON,
    json({ payload: { a: 1 } }),
    [],
    { companyId: 'ACME', projectId: 'N/S' },
  ],
  // Bodies as JSON.parse and zod read them.
  ['create with invalid JSON', 'POST', BUZON, '{"payload":'],
  ['create with an empty body', 'POST', BUZON, ''],
  ['create with trailing text', 'POST', BUZON, '{"payload":{}} x'],
  ['create with a trailing comma', 'POST', BUZON, '{"payload":{"a":1,}}'],
  ['create with a leading zero', 'POST', BUZON, '{"payload":{"a":01}}'],
  ['create with a bare dot number', 'POST', BUZON, '{"payload":{"a":1.}}'],
  ['create with a single-quoted string', 'POST', BUZON, "{'payload':{}}"],
  ['create with a raw control character', 'POST', BUZON, '{"payload":{"a":"\u0001"}}'],
  ['create with an unknown escape', 'POST', BUZON, '{"payload":{"a":"\\x"}}'],
  ['create with a short unicode escape', 'POST', BUZON, '{"payload":{"a":"\\u12"}}'],
  ['create with a byte order mark', 'POST', BUZON, '﻿{"payload":{"a":1}}'],
  ['create with JSON whitespace', 'POST', BUZON, ' \t\r\n{"payload" : { "a" : [ 1 , 2 ] } }\n'],
  ['create with a form feed', 'POST', BUZON, '\f{"payload":{}}'],
  ['create with a no-break space', 'POST', BUZON, ' {"payload":{}}'],
  ['create with a top-level array', 'POST', BUZON, '[]'],
  ['create with a top-level null', 'POST', BUZON, 'null'],
  ['create with a top-level string', 'POST', BUZON, '"x"'],
  ['create with a top-level number', 'POST', BUZON, '1'],
  ['create with a top-level boolean', 'POST', BUZON, 'true'],
  ['create without payload', 'POST', BUZON, '{}'],
  ['create with payload under __proto__', 'POST', BUZON, '{"__proto__":{"payload":{}}}'],
  ['create with an array payload', 'POST', BUZON, '{"payload":[]}'],
  ['create with a null payload', 'POST', BUZON, '{"payload":null}'],
  ['create with a string payload', 'POST', BUZON, '{"payload":"x"}'],
  ['create with a NUL value', 'POST', BUZON, '{"payload":{"a":"x\\u0000"}}'],
  ['create with a NUL key', 'POST', BUZON, '{"payload":{"a\\u0000":1}}'],
  ['create with a nested NUL', 'POST', BUZON, '{"payload":{"a":[1,{"b":["\\u0000"]}]}}'],
  [
    'create with a NUL under top-level __proto__',
    'POST',
    BUZON,
    '{"payload":{"__proto__":"\\u0000","a":1}}',
  ],
  [
    'create with a NUL under nested __proto__',
    'POST',
    BUZON,
    '{"payload":{"x":{"__proto__":"\\u0000"}}}',
  ],
  [
    'create with __proto__ keys',
    'POST',
    BUZON,
    '{"payload":{"__proto__":{"x":1},"b":{"__proto__":{"y":2},"z":3}}}',
  ],
  [
    'create with repeated keys',
    'POST',
    BUZON,
    '{"payload":{"a":1,"b":2,"a":3},"payload":{"c":1,"d":2,"c":{"e":1}}}',
  ],
  [
    'create with index-like keys',
    'POST',
    BUZON,
    '{"payload":{"b":1,"10":2,"2":3,"01":4,"4294967295":5,"4294967294":6,"-1":7}}',
  ],
  [
    'create with numbers',
    'POST',
    BUZON,
    '{"payload":{"a":1e400,"b":-1e400,"c":1e-400,"d":123456789012345678901,"e":0.1,"f":1.0,"g":-0,"h":5e-324,"i":1E2,"j":1e+2}}',
  ],
  [
    'create with escapes',
    'POST',
    BUZON,
    '{"payload":{"a":"\\"\\\\\\/\\b\\f\\n\\r\\t\\u0001\\u001f\\u007f\\u2028<>&é"}}',
  ],
  [
    'create with deep nesting',
    'POST',
    BUZON,
    `{"payload":{"a":${'['.repeat(200)}${']'.repeat(200)}}}`,
  ],
  [
    'create with extra top-level keys',
    'POST',
    BUZON,
    '{"payload":{"a":1},"project_id":"","x":[1]}',
  ],
  [
    'create with invalid UTF-8',
    'POST',
    BUZON,
    {
      bytes:
        '7b227061796c6f6164223a7b2261223a2278ff7880e282417a65d8a080eda080f0908041f4909080c0afe0808022207d7d',
    },
  ],
  [
    'create with invalid UTF-8 outside strings',
    'POST',
    BUZON,
    { bytes: '7b227061796c6f6164223a7b7dff7d' },
  ],
  // Module and route checks come before the body.
  ['create in an unknown module', 'POST', '/api/nada', '{'],
  ['create in the hub', 'POST', '/api/registros', '{"payload":{}}'],
  ['create in a prototype name', 'POST', '/api/constructor', '{"payload":{}}'],
  ['create with an encoded slug', 'POST', '/api/%62uzon', '{"payload":{}}'],
  // Replace.
  [
    'replace a record',
    'PUT',
    `${BUZON}/BZ-1`,
    json({ payload: { Asunto: 'nuevo' } }),
    [['Buzon', 'BZ-1']],
  ],
  ['replace a missing record', 'PUT', `${BUZON}/BZ-1`, json({ payload: { Asunto: 'nuevo' } })],
  [
    'replace with another project',
    'PUT',
    `${BUZON}/BZ-1`,
    json({ payload: { Proyecto_ID: 'OTRO' } }),
    [['Buzon', 'BZ-1']],
  ],
  [
    'replace a missing record with a bad id field',
    'PUT',
    `${BUZON}/BZ-1`,
    json({ payload: { ID_Caso: [] } }),
  ],
  [
    'replace with an id field unlike the path',
    'PUT',
    `${BUZON}/BZ-1`,
    json({ payload: { ID_Caso: 'BZ-2' } }),
    [['Buzon', 'BZ-1']],
  ],
  ['replace an over-long id', 'PUT', `${BUZON}/${'R'.repeat(201)}`, json({ payload: {} })],
  [
    'replace a 200-unit id',
    'PUT',
    `${BUZON}/${'R'.repeat(200)}`,
    json({ payload: {} }),
    [['Buzon', 'R'.repeat(200)]],
  ],
  ['replace an id with a NUL', 'PUT', `${BUZON}/x%00`, json({ payload: {} })],
  [
    'replace an encoded id',
    'PUT',
    `${BUZON}/BZ%2F%C3%B1%20%25`,
    json({ payload: { a: 1 } }),
    [['Buzon', 'BZ/ñ %']],
  ],
  [
    'replace a project',
    'PUT',
    '/api/proyectos/PRJ-1',
    json({ payload: { Nombre: 'n' } }),
    [['Proyectos', 'PRJ-1']],
  ],
  ['replace with invalid JSON', 'PUT', `${BUZON}/BZ-1`, 'nope', [['Buzon', 'BZ-1']]],
  ['replace without payload', 'PUT', `${BUZON}/BZ-1`, '{"x":1}', [['Buzon', 'BZ-1']]],
  ['replace in an unknown module', 'PUT', '/api/nada/BZ-1', 'nope'],
  // Delete.
  ['delete a record', 'DELETE', `${BUZON}/BZ-1`, null, [['Buzon', 'BZ-1']]],
  ['delete a missing record', 'DELETE', `${BUZON}/BZ-1`, null],
  ['delete an over-long id', 'DELETE', `${BUZON}/${'R'.repeat(201)}`, null],
  ['delete an encoded id', 'DELETE', `${BUZON}/BZ%2F%C3%B1%20%25`, null, [['Buzon', 'BZ/ñ %']]],
  ['delete in an unknown module', 'DELETE', '/api/nada/BZ-1', null],
  ['delete with a body', 'DELETE', `${BUZON}/BZ-1`, 'not json', [['Buzon', 'BZ-1']]],
  // Import: module, body and schema.
  ['import into an unknown module', 'POST', '/system/import/nada', '{'],
  ['import users', 'POST', '/system/import/usuarios', rows([])],
  ['import roles', 'POST', '/system/import/roles', rows([])],
  ['import projects', 'POST', '/system/import/proyectos', rows([])],
  ['import with invalid JSON', 'POST', IMPORT, '{"rows":'],
  ['import a top-level array', 'POST', IMPORT, '[]'],
  ['import without rows', 'POST', IMPORT, '{}'],
  ['import with wrong types', 'POST', IMPORT, '{"rows":"x","dry_run":null,"source":5}'],
  [
    'import with bad rows',
    'POST',
    IMPORT,
    '{"rows":[{"a":1},{"b":"x","c":null},[],null,"s",{"__proto__":5,"d":true}],"dry_run":"no"}',
  ],
  ['import with index-like bad keys', 'POST', IMPORT, '{"rows":[{"b":1,"2":false,"1":{}}]}'],
  [
    'import too many rows',
    'POST',
    IMPORT,
    json({ rows: Array(2001).fill(5), dry_run: 'x', source: 's'.repeat(300) }),
  ],
  ['import 2000 empty rows', 'POST', IMPORT, json({ rows: Array(2000).fill({}), dry_run: false })],
  ['import a long source', 'POST', IMPORT, json({ rows: [], source: 's'.repeat(201) })],
  [
    'import a 200-emoji source',
    'POST',
    IMPORT,
    json({ rows: [{ Asunto: 'x' }], source: '😀'.repeat(200), dry_run: false }),
  ],
  ['import a 201-emoji source', 'POST', IMPORT, json({ rows: [], source: '😀'.repeat(201) })],
  [
    'import with lone surrogates in the source',
    'POST',
    IMPORT,
    '{"rows":[],"source":"' + '\\ud800'.repeat(201) + '"}',
  ],
  // Import: plans.
  [
    'import dry run by default',
    'POST',
    IMPORT,
    json({ rows: [{ ID_Caso: 'BZ-1', Asunto: 'a' }, { ID_Caso: 'BZ-2' }, { Asunto: 'nuevo' }] }),
    [['Buzon', 'BZ-1']],
  ],
  [
    'import dry run with problems',
    'POST',
    IMPORT,
    json({ rows: [{ ID_Caso: 'BZ-1' }, { ID_Caso: 'BZ-1' }, { a: 'x\u0000' }], dry_run: true }),
    [['Buzon', 'BZ-1']],
  ],
  [
    'import with problems',
    'POST',
    IMPORT,
    rows([
      { ID_Caso: 'BZ-1' },
      { ID_Caso: ' BZ-1 ' },
      { Proyecto_ID: 'OTRO' },
      { ID_Caso: 'I'.repeat(201) },
      { v: 'x'.repeat(10001) },
      { v: 'x'.repeat(10000) },
      { 'k\u0000': 'v' },
    ]),
    [['Buzon', 'BZ-1']],
  ],
  ['import only blank rows', 'POST', IMPORT, rows([{}, { a: '  ', ' ': 'x' }, { '　': ' ' }])],
  ['import nothing', 'POST', IMPORT, rows([])],
  [
    'import creates and updates',
    'POST',
    IMPORT,
    rows([
      { ID_Caso: 'BZ-1', Asunto: ' a ' },
      { ID_Caso: 'BZ-9', Proyecto_ID: 'PRJ-SECHURA' },
      { Asunto: 'nuevo', Proyecto_ID: '' },
    ]),
    [['Buzon', 'BZ-1']],
  ],
  [
    'import trims and folds field names',
    'POST',
    IMPORT,
    rows([{ ' a ': '1', a: '2', b: ' ', 10: 'x', ' 2': 'y', ' __proto__': 'p', '﻿c': ' d ' }]),
  ],
  [
    'import with __proto__ fields',
    'POST',
    IMPORT,
    '{"rows":[{"__proto__":"x","a":"b"}],"dry_run":false,"source":"s"}',
  ],
  [
    'import into a module without id field',
    'POST',
    '/system/import/directorio',
    rows([{ Nombre: 'a' }, { Nombre: 'b' }]),
  ],
  [
    'import into a module without prefix',
    'POST',
    '/system/import/compromisos',
    rows([{ ID_Compromiso: 'C-1' }, { x: 'y' }]),
  ],
  ['import with an empty source', 'POST', IMPORT, rows([{ a: 'b' }], { source: '  ' })],
  ['import without source', 'POST', IMPORT, '{"rows":[{"a":"b"}],"dry_run":false}'],
  [
    'import with a long source',
    'POST',
    IMPORT,
    rows([{ a: 'b' }], { source: ` ${'s'.repeat(119)}😀tail ` }),
  ],
  ['import with a NUL source', 'POST', IMPORT, rows([{ a: 'b' }], { source: 'a\u0000b' })],
  [
    'import in a scope without project',
    'POST',
    IMPORT,
    rows([{ Proyecto_ID: 'CUALQUIERA' }]),
    [],
    { companyId: 'ACME', projectId: '' },
  ],
  [
    'import with lone surrogates',
    'POST',
    IMPORT,
    '{"rows":[{"ID_Caso":"\\ud800","a":"\\udfff"}],"dry_run":true}',
  ],
  [
    'import repeated ids among many rows',
    'POST',
    IMPORT,
    rows(Array.from({ length: 1201 }, (_, i) => ({ ID_Caso: `M-${i % 1100}`, n: String(i) }))),
  ],
  [
    'import many rows',
    'POST',
    IMPORT,
    rows(Array.from({ length: 1201 }, (_, i) => ({ ID_Caso: `M-${i}`, n: String(i) }))),
    [['Buzon', 'M-7']],
  ],
];

const scenarios = [];
for (const [name, method, path, body, existing = [], scope = SECHURA] of SCENARIOS) {
  const log = [];
  const service = createRecordsService({
    store: memoryStore(existing, log),
    clock: { now: () => new Date(AT) },
    randomHex: countingHex(),
  });
  const routes = recordsRoutes(service, async () => ({ counts: [], rows: [] }));
  const app = new routes.constructor();
  app.use('*', async (c, next) => {
    c.set('scope', scope);
    await next();
  });
  app.route('/', routes);
  app.onError((_error, c) => c.json({ detail: 'Internal Server Error' }, 500));
  const bytes =
    body === null
      ? null
      : typeof body === 'string'
        ? Buffer.from(body, 'utf8')
        : Buffer.from(body.bytes, 'hex');
  const response = await app.request(path, {
    method,
    ...(bytes ? { body: bytes, headers: { 'content-type': 'application/json' } } : {}),
  });
  scenarios.push({
    name,
    method,
    path,
    body: bytes === null ? null : bytes.toString('base64'),
    existing,
    company: scope.companyId,
    project: scope.projectId,
    status: response.status,
    response: await response.text(),
    log,
  });
}

// Formatted as `pnpm lint` (prettier --check) expects.
const text = await format(JSON.stringify({ at: AT, scenarios }), {
  ...(await resolveConfig(OUT)),
  filepath: OUT,
});
if (process.argv.includes('--check')) {
  if (readFileSync(OUT, 'utf8') !== text) {
    console.error('writes.json drifted: rerun without --check');
    process.exit(1);
  }
} else writeFileSync(OUT, text);
