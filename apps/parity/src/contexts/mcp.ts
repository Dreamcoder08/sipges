import { createHash } from 'node:crypto';
import type { ParityCase } from '../types.ts';

/**
 * The MCP server, POST /mcp with API keys of synthetic secrets stored as SHA-256 hex
 * (keyCrypto.hash), so both APIs verify the same rows: a read key, a write key, a read key of
 * limited clearance, a revoked key and a key of PARITY/OTRO, whose rows must stay invisible.
 * Answers compare as JSON and `content[0].text` as a string, so its key order and number spelling
 * count too. Against both APIs a tool's data may differ only where a case names it in `normalize`.
 */
const secret = (letter: string) => letter.repeat(43);
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const KEYS = {
  read: ['c0ffee330001', secret('a')],
  write: ['c0ffee330002', secret('b')],
  limited: ['c0ffee330003', secret('c')],
  revoked: ['c0ffee330004', secret('d')],
  other: ['c0ffee330005', secret('e')],
  onRead: ['c0ffee330006', secret('f')],
  onWrite: ['c0ffee330007', secret('g')],
  onLimited: ['c0ffee330008', secret('h')],
} as const;
type Key = keyof typeof KEYS;
const bearer = (key: Key) => ({ authorization: `Bearer mscli_${KEYS[key][0]}_${KEYS[key][1]}` });

const keyRow = (
  id: number,
  tenant: string,
  name: string,
  key: Key,
  access: string,
  clearance: string,
  revokedAt = 'NULL',
) =>
  `(${id}, '${tenant}', '${name}', '${KEYS[key][0]}', '${sha256(KEYS[key][1])}', '${access}',
   '${clearance}', 'parity', '2026-10-01 00:00:00+00', NULL, ${revokedAt})`;

const DEFAULT_TENANT = 'SIPGES/PRJ-SECHURA';
const OTHER_TENANT = 'PARITY/OTRO'; // not imported: ../fixtures.ts reads these seeds
/** The one project with «Envío a IA externa» on: every other read here is refused. */
const OPEN_TENANT = 'PARITY/MCP';

/** What must never leave: hidden fields, contact data and a known person's name. */
const SECRETS = [
  'oculto-postura-mcp',
  'mcpparidad-oculta',
  'ana@example.org',
  '987 654',
  'Ana Pérez',
];
/** What a restricted record holds. */
const RESTRICTED = ['Reservado Mcpparidad', 'Hecho reservado mcpparidad'];

const row = (id: string, module: string, payload: object, marking = 'interno') =>
  `('${OPEN_TENANT}', '${module}', '${id}', '${JSON.stringify(payload).replaceAll("'", "''")}'::jsonb,
    '${marking}', '2026-01-01 00:00:00+00', '2026-02-03 04:05:06.789+00')`;

const OPEN_RECORDS = [
  row('MCP-A1', 'Actores', {
    ID_Actor: 'MCP-A1',
    'Nombre_Actor/Organizacion': 'Comunidad Mcpparidad Los Algarrobos',
    Tipo_Actor: 'Comunidad',
    Territorio: 'Sechura',
    Influencia: 3,
    Posicion_Proyecto: 'oculto-postura-mcp',
    Telefono: '+51 987 654 321',
    Observaciones: 'mcpparidad-oculta',
    lista: ['mcpparidad-oculta'],
  }),
  row(
    'MCP-A2',
    'Actores',
    { 'Nombre_Actor/Organizacion': 'Frente Reservado Mcpparidad', Territorio: 'Sechura' },
    'restringido',
  ),
  row('MCP-A3', 'Actores', { 'Nombre_Actor/Organizacion': 'Sin Marca Mcpparidad' }, 'publico'),
  row('MCP-D1', 'Directorio_Territorial', {
    Nombre: 'Ana Pérez Núñez',
    Cargo: 'Presidenta',
    Institucion: 'Comunidad Mcpparidad Los Algarrobos',
    Telefono: '+51 987 654 321',
  }),
  row('MCP-E1', 'Eventos', {
    ID_Evento: 'MCP-E1',
    Fecha: '2026-10-01',
    Territorio: 'Sechura',
    Actor_Principal: 'Comunidad Mcpparidad Los Algarrobos',
    Tipo_Evento: 'Asamblea',
    Descripcion_Hecho: `${'Crónica larga. '.repeat(4)}Asamblea mcpparidad convocada por Ana Pérez Núñez (ana@example.org, +51 987 654 321) <b>"agua"</b> & 😀 ${'fin '.repeat(50)}`,
    Fuente_ID: 'MCP-F1',
    Observaciones: 'mcpparidad-oculta',
  }),
  row(
    'MCP-E2',
    'Eventos',
    { Fecha: '2026-10-02', Descripcion_Hecho: 'Hecho reservado mcpparidad' },
    'restringido',
  ),
  row('MCP-E3', 'Eventos', { Fecha: '2025-03', Descripcion_Hecho: 'Mes mcpparidad' }, 'publico'),
  row('MCP-C1', 'Compromisos', {
    ID_Compromiso: 'MCP-C1',
    Fecha: '2025-01-01',
    Descripcion: 'Entrega de agua mcpparidad',
    'Actor/Entidad': 'Comunidad Mcpparidad Los Algarrobos',
    Responsable: 'Ana Pérez Núñez',
    Plazo: '2025-02-01',
    'Avance_%': 50.5,
    Estado: 'Pendiente',
  }),
  row('MCP-F1', 'Fuentes', { Archivo_Fuente: 'acta-mcpparidad.pdf', Tipo_Fuente: 'Acta' }),
];

const link = (id: number, type: string, from: string[], to: string[]) =>
  `(${id}, '${OPEN_TENANT}', '${type}', '${from[0]}', '${from[1]}', '${to[0]}', '${to[1]}', 'nota',
    'parity', '2026-01-02 00:00:00+00')`;

/** Ids and rows are explicit and every insert is ON CONFLICT DO NOTHING. */
export const seed = `
INSERT INTO tenants (company_id, project_id, label) VALUES ('PARITY', 'MCP', 'Proyecto sintético MCP')
ON CONFLICT DO NOTHING;
INSERT INTO project_settings (tenant_id, settings, updated_by, updated_at) VALUES
  ('${OPEN_TENANT}', '{"externalAi":{"enabled":true}}'::jsonb, 'parity', '2026-01-01T00:00:00Z')
ON CONFLICT DO NOTHING;
INSERT INTO module_records (tenant_id, module, id, payload, marking, created_at, updated_at) VALUES
  ${OPEN_RECORDS.join(',\n  ')}
ON CONFLICT DO NOTHING;
INSERT INTO record_links (id, tenant_id, link_type, source_module, source_id, target_module, target_id,
  note, created_by, created_at) OVERRIDING SYSTEM VALUE VALUES
  ${link(33101, 'relacionado_con', ['Eventos', 'MCP-E1'], ['Actores', 'MCP-A2'])},
  ${link(33102, 'sustenta', ['Fuentes', 'MCP-F1'], ['Eventos', 'MCP-E1'])},
  ${link(33103, 'relacionado_con', ['Actores', 'MCP-A2'], ['Actores', 'MCP-A3'])}
ON CONFLICT DO NOTHING;
INSERT INTO api_keys (id, tenant_id, name, prefix, secret_hash, access, clearance, created_by,
  created_at, last_used_at, revoked_at) OVERRIDING SYSTEM VALUE VALUES
  ${keyRow(33001, DEFAULT_TENANT, 'mcp-lectura', 'read', 'read', 'full')},
  ${keyRow(33002, DEFAULT_TENANT, 'mcp-escritura', 'write', 'write', 'full')},
  ${keyRow(33003, DEFAULT_TENANT, 'mcp-limitada', 'limited', 'read', 'limited')},
  ${keyRow(33004, DEFAULT_TENANT, 'mcp-revocada', 'revoked', 'write', 'full', "'2026-10-02 00:00:00+00'")},
  ${keyRow(33005, OTHER_TENANT, 'mcp-ajena', 'other', 'write', 'full')},
  ${keyRow(33006, OPEN_TENANT, 'mcp-abierta-lectura', 'onRead', 'read', 'full')},
  ${keyRow(33007, OPEN_TENANT, 'mcp-abierta-escritura', 'onWrite', 'write', 'full')},
  ${keyRow(33008, OPEN_TENANT, 'mcp-abierta-limitada', 'onLimited', 'read', 'limited')}
ON CONFLICT DO NOTHING;
`;

const PATH = '/mcp';

const post = (name: string, key: Key | null, body: unknown, more: Partial<ParityCase> = {}) => ({
  name: `mcp ${name}`,
  method: 'POST' as const,
  path: PATH,
  headers: key ? bearer(key) : {},
  body: { json: body },
  ...more,
});
const raw = (name: string, body: string) => ({
  name: `mcp ${name}`,
  method: 'POST' as const,
  path: PATH,
  headers: bearer('read'),
  body: { raw: body },
});
const rpc = (method: string, more: object = {}) => ({ jsonrpc: '2.0', id: 1, method, ...more });
const call = (name: string, args?: unknown) =>
  rpc('tools/call', { params: args === undefined ? { name } : { name, arguments: args } });

const transport: readonly ParityCase[] = [
  { name: 'mcp GET', method: 'GET', path: PATH },
  { name: 'mcp GET with a key', method: 'GET', path: PATH, headers: bearer('read') },
  { name: 'mcp HEAD', method: 'HEAD', path: PATH },
  { name: 'mcp DELETE', method: 'DELETE', path: PATH },
  { name: 'mcp PUT', method: 'PUT', path: PATH, body: { json: {} } },
  { name: 'mcp trailing slash', method: 'POST', path: `${PATH}/`, body: { json: {} } },
  post('without a key', null, rpc('ping')),
  post('without a key, before the body', null, {}, { body: { raw: '{' } }),
  raw('unclosed nesting a million levels deep', '['.repeat(1_000_000)),
  post('with a session instead of a key', null, rpc('ping'), { auth: 'admin' }),
  post('with a revoked key', 'revoked', rpc('ping')),
  post('with an unknown key', null, rpc('ping'), { headers: { authorization: 'Bearer mscli_x' } }),
  post('same origin', 'read', rpc('ping'), { sameOrigin: true }),
  post('origin null', 'read', rpc('ping'), { headers: { ...bearer('read'), origin: 'null' } }),
  post('foreign origin', 'read', rpc('ping'), {
    headers: { ...bearer('read'), origin: 'https://otro.example' },
  }),
  post('foreign origin wins over a missing key', null, rpc('ping'), {
    headers: { origin: 'https://otro.example' },
  }),
  raw('invalid JSON', '{'),
  raw('empty body', ''),
  raw('a list', '[]'),
  raw('null', 'null'),
  post('no jsonrpc', 'read', { id: 1, method: 'ping' }),
  post('numeric method', 'read', { jsonrpc: '2.0', id: 1, method: 7 }),
  post('notification', 'read', { jsonrpc: '2.0', method: 'notifications/initialized' }),
  ...['"texto"', '0', '1.50', 'null', 'true', '[1,{"a":2}]', '1e400'].map((id) =>
    raw(`id ${id}`, `{"jsonrpc":"2.0","id":${id},"method":"ping"}`),
  ),
  post('a body naming another project', 'read', {
    ...rpc('ping'),
    params: { project_id: 'OTRO' },
  }),
  post('initialize', 'read', rpc('initialize'), { present: ['listChanged'] }),
  post(
    'initialize, older version',
    'read',
    rpc('initialize', { params: { protocolVersion: '2025-03-26' } }),
  ),
  post(
    'initialize, unknown version',
    'read',
    rpc('initialize', { params: { protocolVersion: '1.0' } }),
  ),
  post('initialize, list as params', 'read', rpc('initialize', { params: ['2025-03-26'] })),
  post('ping', 'read', rpc('ping')),
  post('unknown method', 'read', rpc('resources/list')),
  post('tools/list, read key', 'read', rpc('tools/list'), {
    present: ['search_records'],
    absent: ['create_record'],
  }),
  post('tools/list, write key', 'write', rpc('tools/list'), { present: ['create_record'] }),
  post('tools/list, limited clearance', 'limited', rpc('tools/list')),
  post('tools/list, another project', 'other', rpc('tools/list')),
];

const catalogue: readonly ParityCase[] = [
  post('catalogue', 'read', call('list_object_types'), { present: ['title_field'] }),
  post('catalogue, write key', 'write', call('list_object_types'), { present: ['title_field'] }),
  post('catalogue, limited clearance', 'limited', call('list_object_types')),
  post('catalogue, unknown arguments', 'read', call('list_object_types', { x: 1 })),
  post('catalogue, null arguments', 'read', call('list_object_types', null)),
  post('catalogue, list as arguments', 'read', call('list_object_types', [])),
  post('catalogue, text as arguments', 'read', call('list_object_types', 'x')),
  post('tool without a name', 'read', rpc('tools/call')),
  post('unknown tool', 'read', call('borrar_todo')),
  post(
    'write tool with a read key',
    'read',
    call('create_record', { module: 'demandas', payload: {} }),
  ),
];

/** Zod's refusals, which answer before any tool runs; testdata/mcp.json holds the whole table. */
const refused: readonly ParityCase[] = [
  post('search without a query', 'read', call('search_records', {}), {
    present: ['Argumentos no válidos: query'],
  }),
  post('search with an empty query', 'read', call('search_records', { query: '' })),
  post('search with a long query', 'read', call('search_records', { query: 'x'.repeat(201) })),
  post(
    'search with a long query of emoji',
    'read',
    call('search_records', { query: '😀'.repeat(201) }),
  ),
  post('search, limit 0', 'read', call('search_records', { query: 'a', limit: 0 })),
  post('search, limit 51', 'read', call('search_records', { query: 'a', limit: 51 })),
  post('search, limit 1.5', 'read', call('search_records', { query: 'a', limit: 1.5 })),
  post('search, limit text', 'read', call('search_records', { query: 'a', limit: '5' })),
  post('search, limit null', 'read', call('search_records', { query: 'a', limit: null })),
  post(
    'search, modules text',
    'read',
    call('search_records', { query: 'a', modules: 'x'.repeat(21) }),
  ),
  post(
    'search, too many modules',
    'read',
    call('search_records', { query: 'a', modules: Array(21).fill(1) }),
  ),
  post(
    'search, modules of numbers',
    'read',
    call('search_records', { query: 'a', modules: [1, 'x'.repeat(41)] }),
  ),
  post('record without arguments', 'read', call('get_record')),
  post('record, module and id wrong', 'read', call('get_record', { module: 1, id: '' })),
  post('links, long id', 'read', call('get_links', { module: 'actores', id: 'x'.repeat(201) })),
  post('timeline, long dates', 'read', call('get_timeline', { from: 'x'.repeat(11), to: [1] })),
  post('timeline, limit 201', 'read', call('get_timeline', { limit: 201 })),
  post('briefing, list as id', 'read', call('get_briefing', { module: 'actores', id: [] })),
  post('create without a payload', 'write', call('create_record', { module: 'demandas' })),
  post(
    'create, list as payload',
    'write',
    call('create_record', { module: 'demandas', payload: [] }),
  ),
  post(
    'link, several issues',
    'write',
    call('link_records', { link_type: 1, source: 1, target: { module: 1 } }),
  ),
  post(
    'link, long note',
    'write',
    call('link_records', {
      link_type: 'relacionado_con',
      source: { module: 'actores', id: 'A' },
      target: { module: 'actores', id: 'B' },
      note: 'x'.repeat(501),
    }),
  ),
];

const closed = (name: string, key: Key) =>
  post(`${name}: the switch is off, key ${key}`, key, call(name, READS[name]), {
    present: ['desactivado para este proyecto'],
  });

const READS: Readonly<Record<string, unknown>> = {
  search_records: { query: 'parity' },
  get_record: { module: 'actores', id: 'A-1' },
  get_links: { module: 'actores', id: 'A-1' },
  get_timeline: { from: '2025', to: '2026' },
  get_briefing: { module: 'actores', id: 'A-1' },
};

/** The project with the switch on; `absent` holds what no answer may hold. */
const open = (name: string, tool: string, args: unknown, more: Partial<ParityCase> = {}) =>
  post(name, 'onRead', call(tool, args), { absent: SECRETS, ...more });
const ref = (module: string, id: string) => ({ module, id });

const reads: readonly ParityCase[] = [
  ...Object.keys(READS).flatMap((name) => [closed(name, 'read'), closed(name, 'limited')]),
  open(
    'search',
    'search_records',
    { query: 'mcpparidad' },
    {
      present: ['MCP-E1', 'excerpt'],
      absent: [...SECRETS, ...RESTRICTED],
    },
  ),
  open('search, one module', 'search_records', { query: 'mcpparidad', modules: ['eventos'] }),
  open('search, unknown module', 'search_records', { query: 'mcpparidad', modules: ['otro'] }),
  open('search, empty module list', 'search_records', { query: 'mcpparidad', modules: [] }),
  open('search, limit 1', 'search_records', { query: 'mcpparidad', limit: 1 }),
  open('search, a hidden field alone', 'search_records', { query: 'oculto-postura-mcp' }),
  open('search, a visible word and a hidden one', 'search_records', { query: 'comunidad oculta' }),
  open('search, a name in a hidden field', 'search_records', { query: 'presidenta' }),
  open('search, an exact id', 'search_records', { query: 'MCP-A1' }),
  open('search, punctuation only', 'search_records', { query: '¿?' }),
  open('search, accents', 'search_records', { query: 'CRÓNICA' }),
  open(
    'search with a limited key',
    'search_records',
    { query: 'mcpparidad' },
    {
      headers: bearer('onLimited'),
      absent: [...SECRETS, ...RESTRICTED],
    },
  ),
  open(
    'search from another project',
    'search_records',
    { query: 'mcpparidad' },
    {
      headers: bearer('other'),
      absent: ['MCP-', 'cpparidad'],
    },
  ),
  open('record', 'get_record', ref('actores', 'MCP-A1'), { present: ['updated_at', 'Sechura'] }),
  open('record with text', 'get_record', ref('eventos', 'MCP-E1')),
  open('record with a number', 'get_record', ref('compromisos', 'MCP-C1'), { present: ['50.5'] }),
  open('record of a person', 'get_record', ref('directorio', 'MCP-D1')),
  open('record, restricted', 'get_record', ref('actores', 'MCP-A2'), {
    present: ['withheld'],
    absent: RESTRICTED,
  }),
  open('record, restricted, limited key', 'get_record', ref('actores', 'MCP-A2'), {
    headers: bearer('onLimited'),
    present: ['Registro no encontrado'],
  }),
  open('record, unknown module', 'get_record', ref('otro', 'MCP-A1')),
  open('record, module by stored name', 'get_record', ref('Actores', 'MCP-A1')),
  open('record, missing', 'get_record', ref('actores', 'NADA')),
  open('record of another project', 'get_record', ref('actores', 'MCP-A1'), {
    headers: bearer('other'),
    present: ['Registro no encontrado'],
  }),
  post('record, an id with a NUL', 'onRead', call('get_record', ref('actores', 'A\u0000'))),
  {
    ...raw(
      'record, an id with a lone surrogate',
      '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_record","arguments":{"module":"actores","id":"\\ud83d"}}}',
    ),
    headers: bearer('onRead'),
  },
  open('links', 'get_links', ref('eventos', 'MCP-E1'), {
    present: ['MCP-F1'],
    absent: [...SECRETS, ...RESTRICTED],
  }),
  open('links of an actor, inferred', 'get_links', ref('actores', 'MCP-A1'), {
    present: ['"inferred":true'],
  }),
  open('links, restricted', 'get_links', ref('actores', 'MCP-A2'), {
    present: ['withheld'],
    absent: [...RESTRICTED, 'MCP-A3'],
  }),
  open('links, limited key', 'get_links', ref('eventos', 'MCP-E1'), {
    headers: bearer('onLimited'),
    absent: [...SECRETS, ...RESTRICTED],
  }),
  open('links, missing', 'get_links', ref('actores', 'NADA')),
  open('links, unknown module', 'get_links', ref('otro', 'MCP-A1')),
  open('links of another project', 'get_links', ref('eventos', 'MCP-E1'), {
    headers: bearer('other'),
  }),
  open(
    'timeline',
    'get_timeline',
    {},
    {
      present: ['0000-01-01', 'MCP-E1'],
      absent: [...SECRETS, ...RESTRICTED],
    },
  ),
  open('timeline, year', 'get_timeline', { from: '2026', to: '2026' }),
  open('timeline, months', 'get_timeline', { from: '2025-03', to: '2026-10' }),
  open('timeline, reversed', 'get_timeline', { from: '2026', to: '2025' }),
  open(
    'timeline, invalid date',
    'get_timeline',
    { from: '2026-13' },
    {
      present: ['Fechas no válidas'],
    },
  ),
  open('timeline, spaces', 'get_timeline', { from: ' 2026 ' }),
  open('timeline, one module', 'get_timeline', { modules: ['compromisos'] }),
  open('timeline, a module without dates', 'get_timeline', { modules: ['acciones'] }),
  open('timeline, limit 1', 'get_timeline', { limit: 1 }, { present: ['"truncated":true'] }),
  open(
    'timeline, limited key',
    'get_timeline',
    {},
    {
      headers: bearer('onLimited'),
      absent: [...SECRETS, ...RESTRICTED],
    },
  ),
  open('briefing', 'get_briefing', ref('actores', 'MCP-A1'), {
    present: ['extractivo', 'sources'],
    absent: [...SECRETS, ...RESTRICTED],
  }),
  open('briefing of an event', 'get_briefing', ref('eventos', 'MCP-E1'), {
    absent: [...SECRETS, ...RESTRICTED],
  }),
  open('briefing of a commitment', 'get_briefing', ref('compromisos', 'MCP-C1')),
  open('briefing, restricted', 'get_briefing', ref('actores', 'MCP-A2'), {
    present: ['withheld'],
    absent: RESTRICTED,
  }),
  open('briefing, missing', 'get_briefing', ref('actores', 'NADA')),
  open('briefing, unknown module', 'get_briefing', ref('otro', 'MCP-A1')),
  open('briefing, limited key', 'get_briefing', ref('eventos', 'MCP-E1'), {
    headers: bearer('onLimited'),
  }),
  open('briefing of another project', 'get_briefing', ref('eventos', 'MCP-E1'), {
    headers: bearer('other'),
  }),
];

export const cases: readonly ParityCase[] = [...transport, ...catalogue, ...refused, ...reads];
