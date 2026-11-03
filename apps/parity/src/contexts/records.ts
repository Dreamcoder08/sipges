import type { ParityCase } from '../types.ts';

/**
 * Records, read-only (T25): GET /api/registros/summary, /api/:module, /api/:module/:id and
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
  // Writes stay in TypeScript; the read-only role is refused before any route.
  {
    name: 'records create by the read-only role',
    method: 'POST',
    path: '/api/buzon',
    auth: 'consulta',
    sameOrigin: true,
    body: { json: { payload: { Asunto: 'x' } } },
  },
];
