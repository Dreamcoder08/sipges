// Records the TypeScript MCP server for the Go port's tests (../domain/mcp_args_test.go,
// ../http/mcp_fixtures_test.go): the tool descriptors (zod's JSON schema included), what zod
// answers to every shape of argument, and what the real Hono routes of mcp-routes.ts answer. Run
// from the repository root after changing either side:
//
//   node apps/api-go/internal/integration/testdata/mcp.mjs          # rewrites the two files
//   node apps/api-go/internal/integration/testdata/mcp.mjs --check  # exit 1 when one drifted
//
// Every input is synthetic and built from a fixed seed: no real record or key is read.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { format, resolveConfig } from 'prettier';
import { mcpRoutes } from '../../../../api/src/contexts/integration/http/mcp-routes.ts';
import {
  MCP_TOOLS,
  toolDescriptor,
} from '../../../../api/src/contexts/integration/http/mcp-tools.ts';

const FIXTURE = fileURLToPath(new URL('./mcp.json', import.meta.url));
const DESCRIPTORS = fileURLToPath(new URL('../domain/mcp_tools.json', import.meta.url));

/** mulberry32: a small deterministic generator, so the fixture never changes between runs. */
const random = (seed) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const next = random(20261105);
const pick = (list) => list[Math.floor(next() * list.length)];

// ---- zod: raw JSON text, so 1e400, a key "__proto__" and lone surrogates reach it as they would

const quoted = (text) => JSON.stringify(text);
const lengths = [1, 9, 10, 11, 39, 40, 41, 199, 200, 201, 499, 500, 501];
const list = (items) => `[${items.join(',')}]`;
const many = (n, text) => Array.from({ length: n }, () => text);
const SCALARS = [
  'null',
  'true',
  'false',
  '0',
  '-0',
  '1',
  '-1',
  '0.5',
  '1.5',
  '2',
  '10',
  '50',
  '50.5',
  '51',
  '200',
  '201',
  '1e2',
  '1e400',
  '-1e400',
  '1e300',
  '-1e300',
  '9007199254740991',
  '9007199254740992',
  '-9007199254740991',
  '-9007199254740992',
  '""',
  '"a"',
  '" "',
  '"actores"',
  '"2026-10"',
  '"\\u0000"',
  '"\\ud83d"',
];
const STRINGS = [
  ...lengths.map((n) => quoted('x'.repeat(n))),
  // Zod 4.6 counts code points once a string overflows in UTF-16 units, not units: one per emoji,
  // one per lone surrogate.
  ...[5, 20, 21, 100, 101].map((n) => quoted('😀'.repeat(n))),
  quoted(`${'😀'.repeat(20)}a`),
  quoted(`${'😀'.repeat(5)}`),
  `"${'\\ud83d'.repeat(40)}"`,
  `"${'\\ud83d'.repeat(41)}"`,
];
const ARRAYS = [
  '[]',
  '["a"]',
  '[1]',
  '[null]',
  '[null,"a",2]',
  '[[]]',
  '[{}]',
  `[${quoted('x'.repeat(40))}]`,
  `[${quoted('x'.repeat(41))}]`,
  `[${quoted('x'.repeat(41))},1,${quoted('y'.repeat(41))}]`,
  list(many(20, '"a"')),
  list(many(21, '"a"')),
  list(many(20, quoted('x'.repeat(41)))),
  list(many(21, quoted('x'.repeat(41)))),
  list(many(21, '1')),
  list([...many(19, '"a"'), '1']),
  list([...many(20, '"a"'), '1']),
];
const OBJECTS = [
  '{}',
  '{"a":1}',
  '{"module":"actores"}',
  '{"id":"A-1"}',
  '{"module":"actores","id":"A-1"}',
  '{"module":"actores","id":"A-1","extra":true}',
  '{"module":1,"id":2}',
  '{"module":null,"id":""}',
  `{"module":${quoted('x'.repeat(41))},"id":${quoted('x'.repeat(201))}}`,
  '{"__proto__":{"module":"actores","id":"A-1"}}',
  '{"__proto__":1,"b":2,"1":3,"constructor":4,"toString":{"x":[1e400]}}',
  '{"b":1,"a":2,"b":3}',
  '{"2":"dos","10":"diez","1":"uno","01":"cero uno"}',
  // Zod's length checks read `.length` of whatever they get, an object's own key included.
  '{"length":5}',
  '{"length":0}',
  '{"length":500}',
  '{"length":"30"}',
  '{"length":"x"}',
  '{"length":null}',
  '{"length":true}',
  '{"length":[50]}',
  '{"length":[]}',
  '{"length":{}}',
];
// Out of POOL so its order, and so the seeded cases, stay put. A nested `length` reads as
// Array#toString, which must cost its size and not its depth.
const NESTED_LENGTHS = ['{"length":["",["",[5]]]}', '{"length":[[[[7]]]]}', '{"length":["1",[2]]}'];
const POOL = [...SCALARS, ...STRINGS, ...ARRAYS, ...OBJECTS];

const ID = '"A-1"';
const REF = '{"module":"actores","id":"A-1"}';
/** A valid value for each field of each tool; a field may be left out in every case. */
const FIELDS = {
  list_object_types: {},
  search_records: { query: '"agua"', modules: '["actores"]', limit: '5' },
  get_record: { module: '"actores"', id: ID },
  get_links: { module: '"actores"', id: ID },
  get_timeline: { from: '"2026"', to: '"2026-12"', modules: '["eventos"]', limit: '7' },
  get_briefing: { module: '"actores"', id: ID },
  create_record: { module: '"demandas"', payload: '{"Descripcion":"Sintética"}' },
  link_records: { link_type: '"relacionado_con"', source: REF, target: REF, note: '"nota"' },
};
const object = (entries) =>
  `{${entries.map(([key, value]) => `${quoted(key)}:${value}`).join(',')}}`;

const argumentTexts = (tool) => {
  const fields = Object.entries(FIELDS[tool]);
  const texts = [...SCALARS, ...ARRAYS, ...OBJECTS.slice(0, 3), object(fields)];
  for (const [field] of fields) {
    texts.push(object(fields.filter(([name]) => name !== field)));
    for (const value of POOL) {
      texts.push(object(fields.map(([name, v]) => [name, name === field ? value : v])));
    }
  }
  // Issues keep the order of the schema's fields, not of the arguments.
  texts.push(object([...fields].reverse().map(([name]) => [name, 'null'])));
  texts.push(object([['desconocida', '1'], ...fields, ['__proto__', '{}']]));
  for (let i = 0; i < 160; i += 1) {
    const chosen = fields.flatMap(([name, valid]) => {
      const roll = next();
      if (roll < 0.15) return [];
      return [[name, roll < 0.4 ? valid : pick(POOL)]];
    });
    texts.push(object(chosen));
  }
  if (tool === 'get_record') {
    for (const value of NESTED_LENGTHS)
      texts.push(
        object([
          ['module', value],
          ['id', ID],
        ]),
      );
  }
  return [...new Set(texts)];
};

const zodCases = MCP_TOOLS.flatMap((tool) =>
  argumentTexts(tool.name).map((args) => {
    const parsed = tool.input.safeParse(JSON.parse(args));
    return parsed.success
      ? { tool: tool.name, args, data: JSON.stringify(parsed.data) }
      : {
          tool: tool.name,
          args,
          // The same reduction as mcp-routes.ts.
          issues: parsed.error.issues
            .map((issue) => `${issue.path.join('.') || 'argumentos'}: ${issue.message}`)
            .join('; '),
        };
  }),
);

// ---- The routes, over a fake key service: the transport does not depend on any record

const READ = 'clave-lectura';
const WRITE = 'clave-escritura';
const PRINCIPALS = {
  [READ]: {
    keyId: 1,
    tenantId: 'SIPGES/PRJ-SECHURA',
    name: 'lectura',
    access: 'read',
    clearance: 'full',
  },
  [WRITE]: {
    keyId: 2,
    tenantId: 'SIPGES/PRJ-SECHURA',
    name: 'escritura',
    access: 'write',
    clearance: 'full',
  },
};
const routes = mcpRoutes({
  keys: { authenticate: async (token) => PRINCIPALS[token] ?? null },
  services: {
    guard: { open: async () => ({ ok: false }) },
  },
});

const HOST = 'mcp.example:8080';
const rpc = (method, extra = {}) => JSON.stringify({ jsonrpc: '2.0', id: 1, method, ...extra });
const call = (name, args) =>
  rpc('tools/call', { params: args === undefined ? { name } : { name, arguments: args } });

const originCases = [
  ['no origin', undefined, HOST],
  ['the string null', 'null', HOST],
  ['empty', '', HOST],
  ['same host', 'http://mcp.example:8080', HOST],
  ['upper case', 'HTTP://MCP.EXAMPLE:8080', HOST],
  ['upper-case host header', 'http://mcp.example:8080', 'MCP.EXAMPLE:8080'],
  ['with a path and query', 'https://mcp.example:8080/a/b?c#d', HOST],
  ['with credentials', 'http://ana:clave@mcp.example:8080', HOST],
  ['default port of http', 'http://mcp.example:80', 'mcp.example'],
  ['default port of https', 'https://mcp.example:443', 'mcp.example'],
  ['another default port', 'https://mcp.example:80', 'mcp.example'],
  ['leading zeros in the port', 'http://mcp.example:08080', HOST],
  ['surrounded by spaces', '  http://mcp.example:8080  ', HOST],
  ['another host', 'http://otro.example:8080', HOST],
  ['another port', 'http://mcp.example:8081', HOST],
  ['not a URL', 'mcp.example:8080/ruta con espacios', HOST],
  ['a plain word', 'origen', HOST],
  ['an opaque scheme', 'foo:bar', HOST],
  ['a scheme with a host', 'foo://mcp.example:8080/ruta', HOST],
  ['a scheme with another host', 'foo://otro.example:8080/ruta', HOST],
  ['a scheme with upper-case host', 'foo://MCP.EXAMPLE:8080', HOST],
  ['an IPv4 in hexadecimal', 'http://0x7f.1:8080', '127.0.0.1:8080'],
  ['an IPv6', 'http://[::1]:8080', '[::1]:8080'],
  ['two values', 'http://mcp.example:8080, http://otro.example', HOST],
].map(([label, origin, host]) => ({
  label: `origin: ${label}`,
  method: 'POST',
  host,
  origin,
  key: READ,
  body: rpc('ping'),
}));

const post = (label, body, key = READ) => ({ label, method: 'POST', key, body });
const LONG_IDS = [
  '"texto"',
  '""',
  '0',
  '-0',
  '1.50',
  '1e400',
  'true',
  'false',
  'null',
  '[1,{"a":2}]',
];
const cases = [
  { label: 'GET', method: 'GET' },
  { label: 'GET with a key', method: 'GET', key: READ },
  { label: 'DELETE', method: 'DELETE' },
  { label: 'DELETE with a key', method: 'DELETE', key: WRITE },
  ...originCases,
  {
    label: 'a foreign origin wins over the key',
    method: 'POST',
    origin: 'http://otro.example',
    body: 'x',
  },
  { label: 'no key before the body', method: 'POST', body: 'x' },
  { label: 'an unknown key', method: 'POST', key: 'otra', body: rpc('ping') },
  post('empty body', ''),
  post('invalid JSON', '{'),
  post('trailing text', '{} x'),
  post('a BOM', `\ufeff${rpc('ping')}`),
  { label: 'invalid UTF-8', method: 'POST', key: READ, hex: '7b22ff227d' },
  post('null', 'null'),
  post('a list', '[]'),
  post('a batch', `[${rpc('ping')}]`),
  post('a number', '1'),
  post('a string', '"x"'),
  post('an empty object', '{}'),
  post('another jsonrpc', '{"jsonrpc":"1.0","id":1,"method":"ping"}'),
  post('a numeric jsonrpc', '{"jsonrpc":2,"id":1,"method":"ping"}'),
  post('a numeric method', '{"jsonrpc":"2.0","id":1,"method":1}'),
  post('no method', '{"jsonrpc":"2.0","id":1}'),
  post('a repeated key keeps the last', '{"jsonrpc":"1.0","jsonrpc":"2.0","id":1,"method":"ping"}'),
  post('a notification', '{"jsonrpc":"2.0","method":"notifications/initialized"}'),
  post('a notification of an unknown method', '{"jsonrpc":"2.0","method":"x"}'),
  post('a notification with params', '{"jsonrpc":"2.0","method":"ping","params":[]}'),
  ...LONG_IDS.map((id) => post(`id ${id}`, `{"jsonrpc":"2.0","id":${id},"method":"ping"}`)),
  post('initialize', rpc('initialize')),
  ...['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05', '', 7, null].map((protocolVersion) =>
    post(`initialize ${protocolVersion}`, rpc('initialize', { params: { protocolVersion } })),
  ),
  post('initialize with a list as params', rpc('initialize', { params: ['2025-06-18'] })),
  post('initialize with null params', rpc('initialize', { params: null })),
  post('ping', rpc('ping')),
  post('ping with params', rpc('ping', { params: 1 })),
  post('tools/list, read key', rpc('tools/list')),
  post('tools/list, write key', rpc('tools/list'), WRITE),
  post('an unknown method', rpc('resources/list')),
  post('an empty method', rpc('')),
  post('a method with a lone surrogate', '{"jsonrpc":"2.0","id":1,"method":"\\ud83d"}'),
  post('tools/call without params', rpc('tools/call')),
  post('tools/call with a list', rpc('tools/call', { params: [] })),
  post('tools/call without a name', rpc('tools/call', { params: {} })),
  post('tools/call with a numeric name', rpc('tools/call', { params: { name: 1 } })),
  post('tools/call of an unknown tool', call('borrar_todo')),
  post('a write tool with a read key', call('create_record', {})),
  post('a write tool with a write key', call('create_record', {}), WRITE),
  post('catalogue', call('list_object_types')),
  post('catalogue with a write key', call('list_object_types'), WRITE),
  post('catalogue, null arguments', call('list_object_types', null)),
  post('catalogue, unknown arguments', call('list_object_types', { x: 1 })),
  ...[0, '', false, 1, 'x', true, [], [1]].map((args) =>
    post(`catalogue, arguments ${JSON.stringify(args)}`, call('list_object_types', args)),
  ),
  post('a read tool without arguments', call('get_record')),
  post('a read tool with the switch off', call('get_record', { module: 'actores', id: 'A-1' })),
  post('a search with the switch off', call('search_records', { query: 'agua' })),
  post(
    'several issues',
    call('link_records', { link_type: 1, source: 1, target: { module: 1 } }),
    WRITE,
  ),
];

const answers = [];
for (const c of cases) {
  const headers = { host: c.host ?? HOST };
  if (c.origin !== undefined) headers.origin = c.origin;
  if (c.key) headers.authorization = `Bearer ${c.key}`;
  const body = c.hex ? Buffer.from(c.hex, 'hex') : c.body;
  const response = await routes.request('http://mcp.example:8080/mcp', {
    method: c.method,
    headers,
    body: c.method === 'POST' ? body : undefined,
  });
  answers.push({
    label: c.label,
    method: c.method,
    host: headers.host,
    origin: c.origin ?? null,
    key: c.key ?? null,
    body: c.body ?? null,
    hex: c.hex ?? null,
    status: response.status,
    content_type: response.headers.get('content-type'),
    www_authenticate: response.headers.get('www-authenticate'),
    response: await response.text(),
  });
}

const descriptors = MCP_TOOLS.map((tool) => ({
  write: tool.write,
  descriptor: toolDescriptor(tool),
}));

const outputs = [
  [DESCRIPTORS, JSON.stringify(descriptors)],
  [FIXTURE, JSON.stringify({ zod: zodCases, routes: answers })],
];
let drifted = false;
for (const [file, json] of outputs) {
  const text = await format(json, { ...(await resolveConfig(file)), filepath: file });
  if (process.argv.includes('--check')) {
    if (readFileSync(file, 'utf8') !== text) {
      console.error(`${file} drifted from the TypeScript MCP server; rerun without --check`);
      drifted = true;
    }
  } else {
    writeFileSync(file, text);
  }
}
process.exit(drifted ? 1 : 0);
