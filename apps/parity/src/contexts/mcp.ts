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

/** Ids and rows are explicit and every insert is ON CONFLICT DO NOTHING. */
export const seed = `
INSERT INTO api_keys (id, tenant_id, name, prefix, secret_hash, access, clearance, created_by,
  created_at, last_used_at, revoked_at) OVERRIDING SYSTEM VALUE VALUES
  ${keyRow(33001, DEFAULT_TENANT, 'mcp-lectura', 'read', 'read', 'full')},
  ${keyRow(33002, DEFAULT_TENANT, 'mcp-escritura', 'write', 'write', 'full')},
  ${keyRow(33003, DEFAULT_TENANT, 'mcp-limitada', 'limited', 'read', 'limited')},
  ${keyRow(33004, DEFAULT_TENANT, 'mcp-revocada', 'revoked', 'write', 'full', "'2026-10-02 00:00:00+00'")},
  ${keyRow(33005, OTHER_TENANT, 'mcp-ajena', 'other', 'write', 'full')}
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

export const cases: readonly ParityCase[] = [...transport, ...catalogue, ...refused];
