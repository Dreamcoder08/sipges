import type { ParityCase } from '../types.ts';

/**
 * Records (T25 reads, T36 writes): GET /api/registros/summary, /api/:module, /api/:module/:id and
 * /api/:module/:id/history. The default project gets records whose payloads exercise how both
 * APIs read stored JSON (key order, numbers past float64, `__proto__`, control characters,
 * aliases of the Registros columns), a record marked 'restringido' (hidden from `consulta`), a
 * record with three versions and a deleted one (history), an id that needs decoding and an
 * admin-only module. OTHER_TENANT (see ../fixtures.ts) holds a record with the same id and
 * one of its own, carrying "AJENA", so a leak is plain in a mismatch report. The second project
 * is created later through the API (seed.ts), so its record lists are empty.
 */
const SECHURA = 'SIPGES/PRJ-SECHURA';
const OTHER = 'PARITY/OTRO';

const row = (
  tenant: string,
  module: string,
  id: string,
  payload: unknown,
  at: string,
  marking = 'interno',
) =>
  `('${tenant}', '${module}', '${id.replaceAll("'", "''")}', '${JSON.stringify(payload).replaceAll("'", "''")}', '${marking}', '${at}', '${at}')`;

/** Raw JSON text, for numbers and keys JSON.stringify cannot write (1e400, 1.50, duplicates). */
const raw = (tenant: string, module: string, id: string, json: string, at: string) =>
  `('${tenant}', '${module}', '${id}', '${json.replaceAll("'", "''")}', 'interno', '${at}', '${at}')`;

const LONG_ID = 'R'.repeat(201);

export const seed = `
INSERT INTO module_records (tenant_id, module, id, payload, marking, created_at, updated_at) VALUES
${[
  raw(
    SECHURA,
    'Buzon',
    'PARITY-REC-BZ-1',
    String.raw`{"Asunto": " Consulta \"vecinal\" \\ con\tcontrol \u0001 😀 <b>&</b> ", "Territorio": 1.50,
      "Fecha": 123456789012345678901, "10": "diez", "2": "dos", "01": "cero uno", "_id": "propio",
      "Grande": 1e400, "Pequeño": 1e-400, "Exponente": 1e21, "Lista": [1, 0.1, -0, true, null, {"b": 1, "a": 2}],
      "__proto__": {"x": 1}, "Proyecto_ID": "PRJ-SECHURA"}`,
    '2026-01-03T10:00:00.250Z',
  ),
  row(
    SECHURA,
    'Buzon',
    'PARITY-REC-BZ-R',
    { Asunto: 'Reservado', Territorio: 'Sechura' },
    '2026-01-04T00:00:00Z',
    'restringido',
  ),
  row(
    SECHURA,
    'Buzon',
    'PARITY-REC/ñ %',
    { Asunto: 'Id con barra, eñe y porcentaje' },
    '2026-01-02T00:00:00Z',
  ),
  row(SECHURA, 'Buzon', 'PARITY-REC-BZ-DEL', { Asunto: 'Eliminado' }, '2026-01-01T00:00:00Z'),
  row(
    SECHURA,
    'Directorio_Territorial',
    'PARITY-REC-DIR-1',
    {
      Nombre: '',
      'Nombre actualizado 2026': 'Junta vecinal sintética',
      Territorio: '',
      'Lugar / ámbito': '  Caleta sintética  ',
    },
    '2026-01-02T00:00:00Z',
  ),
  row(
    SECHURA,
    'Directorio_Territorial',
    'PARITY-REC-DIR-2',
    {
      Nombre: null,
      Ciudad: 'Ciudad sintética',
      Distrito: { zona: 2, área: [1] },
    },
    '2026-01-02T00:00:00Z',
  ),
  row(
    SECHURA,
    'Fuentes',
    'PARITY-REC-F-1',
    {
      Archivo_Fuente: 'acta-sintetica.pdf',
      Fecha_Documento: '2025-12-31',
      Nivel_Base_Verificacion: 'A - Confirmada',
    },
    '2026-01-05T00:00:00Z',
  ),
  row(
    SECHURA,
    'Narrativas',
    'PARITY-REC-N-1',
    {
      Descripcion: ' Narrativa sintética　',
      Fecha_Inicio: 20260101,
      Nivel_Verificacion: 'C - Posible',
    },
    '2026-01-05T00:00:00Z',
  ),
  row(
    SECHURA,
    'Usuarios',
    'PARITY-REC-USR-1',
    { ID_Usuario: 'PARITY-REC-USR-1', Nombre: 'Cuenta sintética' },
    '2026-01-05T00:00:00Z',
  ),
  row(
    OTHER,
    'Buzon',
    'PARITY-REC-BZ-1',
    { Asunto: 'Fila AJENA', Territorio: 'AJENA' },
    '2026-02-01T00:00:00Z',
  ),
  row(OTHER, 'Buzon', 'PARITY-REC-AJENA', { Asunto: 'Fila AJENA' }, '2026-02-01T00:00:00Z'),
  // Write targets (T36): replaced and imported into; only the write cases read them.
  row(
    SECHURA,
    'Compromisos',
    'PARITY-W-PUT',
    { Texto: 'antes', Queda: 'no' },
    '2026-01-08T00:00:00Z',
  ),
  row(
    SECHURA,
    'Compromisos',
    'PARITY-W-IMP-1',
    { Texto: 'uno', Extra: 'se queda' },
    '2026-01-08T00:00:00Z',
  ),
  row(SECHURA, 'Compromisos', 'PARITY-W-IMP-2', { Texto: 'dos' }, '2026-01-08T00:00:00Z'),
].join(',\n')};
UPDATE module_records SET payload = payload - 'Territorio' || '{"Asunto": "Consulta revisada", "Estado": "Abierto", "constructor": 1}',
  updated_at = '2026-01-06T00:00:00Z' WHERE tenant_id = '${SECHURA}' AND module = 'Buzon' AND id = 'PARITY-REC-BZ-1';
UPDATE module_records SET payload = payload - '__proto__' || '{"Estado": "Cerrado", "Lista": [1, 0.10, 0, true, null, {"a": 2, "b": 1}]}',
  updated_at = '2026-01-07T00:00:00Z' WHERE tenant_id = '${SECHURA}' AND module = 'Buzon' AND id = 'PARITY-REC-BZ-1';
DELETE FROM module_records WHERE tenant_id = '${SECHURA}' AND module = 'Buzon' AND id = 'PARITY-REC-BZ-DEL';
`;

type Route = { readonly key: string; readonly path: string };

const ROUTES: readonly Route[] = [
  { key: 'summary', path: '/api/registros/summary' },
  { key: 'list', path: '/api/buzon' },
  { key: 'get', path: '/api/buzon/PARITY-REC-BZ-1' },
  { key: 'history', path: '/api/buzon/PARITY-REC-BZ-1/history' },
];

/** The scope and session cases every route gets. */
const scoped = ({ key, path }: Route): ParityCase[] => [
  { name: `records ${key}`, method: 'GET', path, auth: 'admin' },
  { name: `records ${key} without a session`, method: 'GET', path },
  { name: `records ${key} read-only role`, method: 'GET', path, auth: 'consulta' },
  {
    name: `records ${key} of a project without a grant`,
    method: 'GET',
    path,
    auth: 'admin',
    headers: { 'x-sipges-scope': 'PARITY/PRJ-B' },
  },
  {
    name: `records ${key} of the ungranted fixture project`,
    method: 'GET',
    path,
    auth: 'multi',
    headers: { 'x-sipges-scope': OTHER },
  },
  {
    name: `records ${key} with project_id of another project`,
    method: 'GET',
    path: `${path}?project_id=PRJ-B`,
    auth: 'admin',
  },
  {
    name: `records ${key} with project_id of its project`,
    method: 'GET',
    path: `${path}?project_id=PRJ-SECHURA`,
    auth: 'admin',
  },
  { name: `records ${key} before choosing a project`, method: 'GET', path, auth: 'multi' },
  {
    name: `records ${key} of the second project`,
    method: 'GET',
    path,
    auth: 'multi',
    headers: { 'x-sipges-scope': 'PARITY/PRJ-B' },
  },
  {
    name: `records ${key} of the first project by a two-project user`,
    method: 'GET',
    path,
    auth: 'multi',
    headers: { 'x-sipges-scope': SECHURA },
  },
  { name: `records ${key} with a trailing slash`, method: 'GET', path: `${path}/`, auth: 'admin' },
  { name: `records ${key} HEAD`, method: 'HEAD', path, auth: 'admin' },
];

const get = (name: string, path: string, auth: ParityCase['auth'] = 'admin'): ParityCase => ({
  name: `records ${name}`,
  method: 'GET',
  path,
  auth,
});

/** Query validation of the two list routes, in the TypeScript order: limit, then offset. */
const paged = (key: string, path: string): ParityCase[] => [
  get(`${key} limit not an integer`, `${path}?limit=abc`),
  get(`${key} limit decimal`, `${path}?limit=1.5`),
  get(`${key} limit empty`, `${path}?limit=`),
  get(`${key} limit and offset both invalid`, `${path}?limit=x&offset=-1`),
  get(`${key} offset negative`, `${path}?offset=-1`),
  get(`${key} offset not an integer`, `${path}?offset=1e3`),
  get(`${key} offset past the safe integers`, `${path}?offset=9007199254740992`),
  get(`${key} offset at the safe integer limit`, `${path}?offset=9007199254740991`),
  get(`${key} offset with spaces and a sign`, `${path}?offset=%20%2B1%20`),
  get(`${key} limit zero`, `${path}?limit=0`),
  get(`${key} limit one, offset one`, `${path}?limit=1&offset=1`),
  get(`${key} negative limit (capped)`, `${path}?limit=-5`),
  get(`${key} huge limit (capped)`, `${path}?limit=99999999999999999999`),
  get(`${key} search`, `${path}?q=sint%C3%A9tica`),
  get(`${key} search by id, any case`, `${path}?q=parity-rec-bz`),
  get(`${key} search with no match`, `${path}?q=AJENA`),
  get(`${key} empty search`, `${path}?q=`),
  get(`${key} search with plus as space`, `${path}?q=Consulta+revisada`),
  get(
    `${key} search for a restricted row by the read-only role`,
    `${path}?q=Reservado`,
    'consulta',
  ),
];

export const cases: readonly ParityCase[] = [
  ...ROUTES.flatMap(scoped),
  ...paged('summary', '/api/registros/summary'),
  ...paged('list', '/api/buzon'),
  // Modules: unknown before any query check, the hub is no record type, slugs decode.
  get('list of an unknown module', '/api/nada'),
  get('unknown module before an invalid limit', '/api/nada?limit=abc'),
  get('list of the hub', '/api/registros'),
  get('list of a prototype name', '/api/constructor'),
  get('get of an unknown module', '/api/nada/PARITY-REC-BZ-1'),
  get('history of an unknown module', '/api/nada/PARITY-REC-BZ-1/history'),
  get('list with an encoded slug', '/api/%62uzon'),
  get('list of another module', '/api/directorio'),
  get('list of narratives', '/api/narrativas'),
  get('list of sources', '/api/fuentes'),
  get('list of an empty module', '/api/aarc'),
  get('summary of the hub with the module path', '/api/registros/summary/'),
  // Admin-only modules: the role gate refuses the read-only role.
  get('admin-only module', '/api/usuarios'),
  get('admin-only module, read-only role', '/api/usuarios', 'consulta'),
  get('admin-only record, read-only role', '/api/usuarios/PARITY-REC-USR-1', 'consulta'),
  get('admin-only history, read-only role', '/api/roles/x/history', 'consulta'),
  get('projects module, read-only role', '/api/proyectos', 'consulta'),
  // One record.
  get('get with an encoded id', '/api/buzon/PARITY-REC%2F%C3%B1%20%25'),
  get('get with an invalid escape', '/api/buzon/PARITY-REC%2F%C3%B1%20%25%FF'),
  get('get of a missing record', '/api/buzon/PARITY-REC-NADA'),
  get('get of a deleted record', '/api/buzon/PARITY-REC-BZ-DEL'),
  get('get of an over-long id', `/api/buzon/${LONG_ID}`),
  get('get of an id with a NUL', '/api/buzon/PARITY-REC%00'),
  get('get of another project id', '/api/buzon/PARITY-REC-AJENA'),
  get('get of another project id, its user', '/api/buzon/PARITY-REC-AJENA', 'multi'),
  get('get of a restricted record', '/api/buzon/PARITY-REC-BZ-R'),
  get('get of a restricted record, read-only role', '/api/buzon/PARITY-REC-BZ-R', 'consulta'),
  get('get of a record in another module', '/api/eventos/PARITY-REC-BZ-1'),
  get('get of a directory entry', '/api/directorio/PARITY-REC-DIR-2'),
  get('get of the history id', '/api/buzon/history'),
  // History.
  get('history of a deleted record', '/api/buzon/PARITY-REC-BZ-DEL/history'),
  get('history of a missing record', '/api/buzon/PARITY-REC-NADA/history'),
  get('history of an over-long id', `/api/buzon/${LONG_ID}/history`),
  get('history of an encoded id', '/api/buzon/PARITY-REC%2F%C3%B1%20%25/history'),
  get('history of another project id', '/api/buzon/PARITY-REC-AJENA/history'),
  get('history of a restricted record', '/api/buzon/PARITY-REC-BZ-R/history'),
  get(
    'history of a restricted record, read-only role',
    '/api/buzon/PARITY-REC-BZ-R/history',
    'consulta',
  ),
  get('history with a trailing segment', '/api/buzon/PARITY-REC-BZ-1/history/x'),
  // Writes (T36) follow every read above, so no read case sees their effect.
  ...writeCases(),
];

/**
 * The runner sends each case to both APIs at once, on one database: a write case must answer the
 * same whichever API runs first. So successes replace or merge seeded records (idempotent), a
 * create normalizes the id it got (the second one collides and takes `<id>-<4 hex>`, which is the
 * concurrent-duplicate outcome TypeScript defines), and the reads after them prove what both
 * stored. A successful delete cannot answer the same twice (the second finds nothing); it is
 * covered by the Go integration tests and the fixtures recorded from TypeScript.
 */
function writeCases(): ParityCase[] {
  const SECOND = { 'x-sipges-scope': 'PARITY/PRJ-B' };
  const write = (
    name: string,
    method: ParityCase['method'],
    path: string,
    body?: ParityCase['body'],
    extra: Partial<ParityCase> = {},
  ): ParityCase => ({
    name: `records ${name}`,
    method,
    path,
    auth: 'admin',
    sameOrigin: true,
    ...(body ? { body } : {}),
    ...extra,
  });
  const create = (name: string, raw: string, extra: Partial<ParityCase> = {}) =>
    write(name, 'POST', '/api/buzon', { raw }, extra);
  const imported = (name: string, raw: string, extra: Partial<ParityCase> = {}) =>
    write(name, 'POST', '/system/import/compromisos', { raw }, extra);
  const PUT = '/api/compromisos/PARITY-W-PUT';
  const NEW = { auth: 'multi', headers: SECOND } as const;
  return [
    // Session, Origin, project scope and role gates, before any route.
    {
      name: 'records create without a session',
      method: 'POST',
      path: '/api/buzon',
      sameOrigin: true,
      body: { json: { payload: {} } },
    },
    {
      name: 'records create without Origin',
      method: 'POST',
      path: '/api/buzon',
      auth: 'admin',
      body: { json: { payload: {} } },
    },
    write(
      'create by the read-only role',
      'POST',
      '/api/buzon',
      { json: { payload: { Asunto: 'x' } } },
      { auth: 'consulta' },
    ),
    write(
      'replace by the read-only role',
      'PUT',
      PUT,
      { json: { payload: {} } },
      { auth: 'consulta' },
    ),
    write('delete by the read-only role', 'DELETE', PUT, undefined, { auth: 'consulta' }),
    write(
      'import by the read-only role',
      'POST',
      '/system/import/compromisos',
      { json: { rows: [] } },
      { auth: 'consulta' },
    ),
    write(
      'create before choosing a project',
      'POST',
      '/api/buzon',
      { json: { payload: {} } },
      { auth: 'multi' },
    ),
    write(
      'create in the ungranted fixture project',
      'POST',
      '/api/buzon',
      { json: { payload: {} } },
      { auth: 'multi', headers: { 'x-sipges-scope': OTHER } },
    ),
    create('create naming another project', '{"payload":{"Proyecto_ID":"PRJ-B"}}'),
    create('create with project_id of another project', '{"project_id":"PRJ-B","payload":{}}'),
    write(
      'create with query project_id of another project',
      'POST',
      '/api/buzon?project_id=PRJ-B',
      { json: { payload: {} } },
    ),
    create('create naming another project as plain text', '{"payload":{"Proyecto_ID":"PRJ-B"}}', {
      headers: { 'content-type': 'text/plain' },
    }),
    create('create naming project zero', '{"payload":{"Proyecto_ID":0}}'),
    write('create a user as analyst', 'POST', '/api/usuarios', { json: { payload: {} } }, NEW),
    write('create a project as analyst', 'POST', '/api/proyectos', { json: { payload: {} } }, NEW),
    write(
      'import users as analyst',
      'POST',
      '/system/import/usuarios',
      { json: { rows: [] } },
      NEW,
    ),
    // Modules and paths.
    create('create in an unknown module', '{', { path: '/api/nada' }),
    create('create in the hub', '{"payload":{}}', { path: '/api/registros' }),
    create('create with a trailing slash', '{"payload":{}}', { path: '/api/buzon/' }),
    write('replace without an id', 'PUT', '/api/buzon', { json: { payload: {} } }),
    write('patch a record', 'PATCH', PUT, { json: { payload: {} } }),
    imported('import into an unknown module', '{', { path: '/system/import/nada' }),
    imported('import projects', '{"rows":[]}', { path: '/system/import/proyectos' }),
    // Bodies refused before any write (TypeScript's zod messages and loc paths).
    create('create with invalid JSON', '{"payload":'),
    create('create with an empty body', ''),
    create('create with a top-level array', '[]'),
    create('create without payload', '{"x":1}'),
    create('create with an array payload', '{"payload":[]}'),
    create('create with a NUL value', '{"payload":{"a":"x\\u0000"}}'),
    create('create with a NUL key', '{"payload":{"a\\u0000":1}}'),
    create('create with a boolean id', '{"payload":{"ID_Caso":true}}'),
    create(
      'create with an over-long id',
      JSON.stringify({ payload: { ID_Caso: 'I'.repeat(201) } }),
    ),
    create(
      'create with 101 emoji as id',
      JSON.stringify({ payload: { ID_Caso: '😀'.repeat(101) } }),
    ),
    create(
      'create with a lone surrogate (jsonb refuses it)',
      '{"payload":{"ID_Caso":"PARITY-W-SUR","a":"\\ud800"}}',
    ),
    // Replace: idempotent, then read back.
    write('replace a missing record with a bad id field', 'PUT', '/api/compromisos/PARITY-W-NADA', {
      raw: '{"payload":{"ID_Compromiso":[]}}',
    }),
    write('replace a missing record', 'PUT', '/api/compromisos/PARITY-W-NADA', {
      json: { payload: {} },
    }),
    write('replace another project record', 'PUT', '/api/buzon/PARITY-REC-AJENA', {
      json: { payload: {} },
    }),
    write('replace an over-long id', 'PUT', `/api/buzon/${LONG_ID}`, { json: { payload: {} } }),
    write(
      'replace naming another project',
      'PUT',
      PUT,
      { raw: '{"payload":{"Proyecto_ID":"OTRO"}}' },
      { headers: { 'content-type': 'text/plain' } },
    ),
    write('replace a record', 'PUT', PUT, {
      raw: '{"payload":{"Texto":"después","n":1.50,"__proto__":{"x":1},"Lista":[1e400,-0,{"b":1,"a":2}],"2":"dos"}}',
    }),
    write('replace a record again', 'PUT', PUT, {
      raw: '﻿ {"payload":{"2":"dos","Texto":"después","n":1.5,"Lista":[null,0,{"a":2,"b":1}]}} ',
    }),
    get('get a replaced record', PUT),
    { ...get('history of a replaced record', `${PUT}/history`), normalize: ['*.at'] },
    // Delete: refused or missing (a success is not the same twice).
    write('delete a missing record', 'DELETE', '/api/compromisos/PARITY-W-NADA'),
    write('delete another project record', 'DELETE', '/api/buzon/PARITY-REC-AJENA'),
    write('delete an over-long id', 'DELETE', `/api/buzon/${LONG_ID}`),
    write('delete in an unknown module', 'DELETE', '/api/nada/x'),
    // Create: both APIs store one record each; the second takes `<id>-<4 hex>`.
    {
      ...create(
        'create with its id',
        '{"payload":{"ID_Caso":"PARITY-W-NUEVO","Asunto":"Nuevo"}}',
        NEW,
      ),
      normalize: ['id'],
    },
    get('created record before choosing a project', '/api/buzon/PARITY-W-NUEVO', 'multi'),
    {
      ...get('created record in its project', '/api/buzon/PARITY-W-NUEVO', 'multi'),
      headers: SECOND,
    },
    {
      ...get('created records listed', '/api/buzon?q=PARITY-W-NUEVO', 'multi'),
      headers: SECOND,
      normalize: ['*._id', '*._updated_at'],
    },
    {
      ...get('created record history', '/api/buzon/PARITY-W-NUEVO/history', 'multi'),
      headers: SECOND,
      normalize: ['*.at'],
    },
    get('created record never in the first project', '/api/buzon/PARITY-W-NUEVO'),
    {
      ...create('create with a generated id', '{"payload":{"Descripcion_Hecho":"generado"}}', {
        ...NEW,
        path: '/api/eventos',
      }),
      normalize: ['id'],
    },
    {
      ...get('generated records listed', '/api/eventos?q=generado', 'multi'),
      headers: SECOND,
      normalize: ['*._id', '*._updated_at'],
    },
    {
      ...create('create with a numeric id', '{"payload":{"ID_Demanda":42.50}}', {
        ...NEW,
        path: '/api/demandas',
      }),
      normalize: ['id'],
    },
    {
      ...get('numeric id listed', '/api/demandas', 'multi'),
      headers: SECOND,
      normalize: ['*._id', '*._updated_at'],
    },
    {
      ...create(
        'create with an id only another project holds',
        '{"payload":{"ID_Caso":"PARITY-REC-AJENA","Asunto":"propia"}}',
      ),
      normalize: ['id'],
    },
    get('get the id another project also holds', '/api/buzon/PARITY-REC-AJENA'),
    // Import: dry runs and refusals write nothing; a merge into seeded ids is idempotent.
    imported(
      'import dry run by default',
      JSON.stringify({
        rows: [
          { ID_Compromiso: 'PARITY-W-IMP-1' },
          { ID_Compromiso: 'PARITY-W-IMP-2' },
          { Texto: 'nuevo' },
        ],
      }),
    ),
    imported(
      'import dry run with problems',
      JSON.stringify({
        dry_run: true,
        rows: [
          { ID_Compromiso: 'PARITY-W-IMP-1' },
          { ID_Compromiso: ' PARITY-W-IMP-1 ' },
          { a: 'x\u0000' },
          { Proyecto_ID: 'PRJ-B' },
          { v: 'x'.repeat(10001) },
        ],
      }),
    ),
    imported(
      'import with problems',
      JSON.stringify({
        dry_run: false,
        rows: [{ ID_Compromiso: 'PARITY-W-NO' }, { ID_Compromiso: 'I'.repeat(201) }],
      }),
    ),
    get('refused import wrote nothing', '/api/compromisos/PARITY-W-NO'),
    imported('import only blank rows', JSON.stringify({ dry_run: false, rows: [{}, { a: '  ' }] })),
    imported('import with wrong types', '{"rows":"x","dry_run":null,"source":5}'),
    imported(
      'import with bad rows',
      '{"rows":[{"a":1},{"b":"x","c":null},[],null,{"__proto__":5,"d":true}],"dry_run":"no"}',
    ),
    imported(
      'import too many rows',
      JSON.stringify({ rows: Array(2001).fill({}), source: 's'.repeat(201) }),
    ),
    imported('import a long source', JSON.stringify({ rows: [], source: '😀'.repeat(201) })),
    imported(
      'import merges into its records',
      JSON.stringify({
        dry_run: false,
        source: '  hoja sintética.xlsx  ',
        rows: [
          { ID_Compromiso: 'PARITY-W-IMP-1', Texto: ' uno nuevo ', Vacio: ' ' },
          { ID_Compromiso: 'PARITY-W-IMP-2', '10': 'diez' },
        ],
      }),
    ),
    get('get an imported record', '/api/compromisos/PARITY-W-IMP-1'),
    {
      ...get('history of an imported record', '/api/compromisos/PARITY-W-IMP-2/history'),
      normalize: ['*.at'],
    },
  ];
}
