/**
 * Synthetic legacy installations for the migrate-legacy differential run: rows the tool must
 * refuse, odd values it must carry over byte for byte, and file layouts it must not follow.
 * Every value is invented. Columns have no declared type, so SQLite keeps each value's storage
 * class exactly as written here.
 */
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const sha = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');
const digest = (tenant: string) => sha(tenant).slice(0, 24);
const HASH = `pbkdf2_sha256$310000$${'a'.repeat(32)}$${'b'.repeat(64)}`;
const NOW = '2026-10-01T09:00:00';

/** Blobs and text with embedded NUL keep their storage class (a parameter string would too). */
const blob = (text: string) => new Uint8Array(Buffer.from(text, 'utf8'));

const COLUMNS = {
  auth_users: 'username, full_name, password_hash, role, active, created_at, totp_secret, totp_enabled',
  auth_sessions: 'token_hash, username, expires_at, created_at',
  tenant_projects: 'company_id, project_id, label',
  access_grants: 'username, company_id, project_id',
  records: 'module, record_id, payload, created_at, updated_at',
  audit: 'id INTEGER PRIMARY KEY, ts, module, record_id, action, detail',
  irsa_snapshots: 'id INTEGER PRIMARY KEY, ts, irsa, level, scores, config_version, note',
  attachments:
    'id, stored_name, original_name, content_type, size_bytes, sha256, linked_module, linked_record_id, document_type, author, verification, notes, project_id, project_name, created_at',
  document_review:
    'id, project_id, source_file, source_sha256, location, theme, excerpt, action, status, reviewer, note, created_at, updated_at',
  digital_alert_reviews:
    'id, project_id, created_at, source_url, source_type, excerpt, sha256, level, score, method, themes_json, signals_json, suggestions_json, semantic_active, status, analyst_note, reviewer_note, reviewed_at',
  preventive_actions:
    'id, project_id, alert_id, title, responsible, due_date, description, status, progress, created_at, updated_at',
  preventive_action_log: 'id, action_id, created_at, status, progress, note, evidence_url',
} as const;

type Table = keyof typeof COLUMNS;
type Cell = string | number | bigint | Uint8Array | null;

const open = (path: string, tables: readonly Table[]) => {
  const db = new DatabaseSync(path);
  for (const table of tables) db.exec(`CREATE TABLE ${table} (${COLUMNS[table]})`);
  return db;
};

const insert = (db: DatabaseSync, table: Table, rows: readonly (readonly Cell[])[]) => {
  for (const row of rows) {
    const marks = row.map(() => '?').join(',');
    db.prepare(`INSERT INTO ${table} VALUES (${marks})`).run(...row);
  }
};

/** `new Date()` input shapes, valid and not; each one lands in a `ts` and a `created_at`. */
export const HOSTILE_TIMESTAMPS: readonly Cell[] = [
  '2026-10-01T09:00:00',
  '2026-10-01 09:00:00',
  '2026-10-01 09:00:00.123456',
  '2026-10-01T09:00:00.5Z',
  '2026-10-01T09:00:00+05:30',
  '2026-10-01T09:00:00-0300',
  '  2026-10-01T09:00:00  ',
  '2026-10-01',
  '2026-10',
  '2026',
  '2026-02-31',
  '2026-13-01',
  '2026-00-10',
  '2026-10-01T24:00:00',
  '2026-10-01T24:00:01',
  '2026-10-01T25:00:00',
  '+012026-10-01T00:00:00',
  '-000001-01-01T00:00:00',
  '-000000-01-01T00:00:00',
  '+275760-09-13T00:00:00',
  '+275760-09-13T00:00:01',
  '10/01/2026',
  '1/2/26',
  '2026/10/01 09:00',
  'Oct 1 2026',
  '1 October 2026 10:00 PM',
  'Thu, 01 Oct 2026 09:00:00 GMT',
  'Thursday October 1 2026 09:00:00 EST',
  'ayer',
  'x 2026',
  '12:30',
  '5',
  '',
  '   ',
  1_790_000_000,
  1_790_000_000.75,
  -1.5,
  0,
  8_640_000_000_000,
  8_640_000_000_001,
  9e300,
  null,
  blob('2026-10-01T09:00:00'),
  blob('\xff'),
];

const SHA_A = sha('a');

const buildAuth = (data: string, tenants: readonly (readonly Cell[])[]) => {
  const auth = open(join(data, 'auth_global.db'), [
    'auth_users',
    'auth_sessions',
    'tenant_projects',
    'access_grants',
  ]);
  insert(auth, 'auth_users', [
    ['  ana  ', 'Ana', HASH, 'admin', 1, NOW, null, 0],
    ['ana', 'Ana duplicada', HASH, 'analista', 0, NOW, '', 1],
    ['bea', 'Bea', HASH, 'coordinador', '0', 1_790_000_000, 'JBSWY3DPEHPK3PXP', 1],
    ['carla', 'Carla ñandú 😀', HASH, 'consulta', null, '2026-10-01', 'sinactivar', null],
    ['diego', 'Diego', HASH, 'consulta', 'true', NOW, null, 'true'],
    ['elena', 'Elena', HASH, 'consulta', blob('true'), NOW, null, blob('1')],
    ['fabio', 'Fabio', HASH, 'consulta', 'no', NOW, null, 0.5],
    ['', 'Sin nombre', HASH, 'admin', 1, NOW, null, 0],
    [null, 'Nulo', HASH, 'admin', 1, NOW, null, 0],
    ['x'.repeat(121), 'Largo', HASH, 'admin', 1, NOW, null, 0],
    ['😀'.repeat(61), 'Largo en UTF-16', HASH, 'admin', 1, NOW, null, 0],
    ['😀'.repeat(60), 'Justo 120', HASH, 'consulta', 1, NOW, null, 0],
    ['n\0l', 'NUL', HASH, 'admin', 1, NOW, null, 0],
    ['gina', 'NUL\0nombre', HASH, 'admin', 1, NOW, null, 0],
    ['hugo', null, HASH, 'admin', 1, NOW, null, 0],
    ['ines', 'Hash', 'md5$1$a$b', 'admin', 1, NOW, null, 0],
    ['juan', 'Hash', `${HASH}\n`, 'admin', 1, NOW, null, 0],
    ['kira', 'Rol', HASH, 'root', 1, NOW, null, 0],
    ['luis', 'Fecha', HASH, 'admin', 1, 'ayer', null, 0],
    [blob('marta'), 'Blob', HASH, 'consulta', 1, NOW, null, 0],
    [12345, 'Numero', HASH, 'consulta', 1, NOW, null, 0],
    [blob('\xff\xfe'), 'Blob invalido', 'mal', 'admin', 1, NOW, null, 0],
  ]);
  insert(auth, 'auth_sessions', [
    ['t1', 'ana', 1, NOW],
    ['t2', 'bea', 2, NOW],
  ]);
  insert(auth, 'tenant_projects', tenants);
  insert(auth, 'access_grants', [
    ['ana', 'SIPGES', 'PRJ-SECHURA'],
    ['  ana  ', 'SIPGES', 'PRJ-SECHURA'],
    ['bea', 'ACME', 'PRJ-B'],
    ['nadie', 'ACME', 'PRJ-B'],
    ['bea', 'NO', 'EXISTE'],
    [blob('bea'), blob('ACME'), 'PRJ-B'],
    [null, null, null],
  ]);
  auth.close();
};

const tenantTables: readonly Table[] = [
  'records',
  'audit',
  'irsa_snapshots',
  'attachments',
  'document_review',
  'digital_alert_reviews',
  'preventive_actions',
  'preventive_action_log',
];

const attachment = (
  id: Cell,
  stored: Cell,
  overrides: Partial<Record<'name' | 'type' | 'size' | 'sha' | 'module' | 'record' | 'at', Cell>> = {},
): Cell[] => [
  id,
  stored,
  overrides.name ?? 'original.txt',
  overrides.type === undefined ? 'text/plain' : overrides.type,
  overrides.size === undefined ? 1 : overrides.size,
  overrides.sha === undefined ? null : overrides.sha,
  overrides.module === undefined ? 'eventos' : overrides.module,
  overrides.record === undefined ? 'EV-1' : overrides.record,
  'tipo',
  'autor',
  'E',
  null,
  null,
  null,
  overrides.at === undefined ? NOW : overrides.at,
];

const buildDefaultTenant = (data: string) => {
  const db = open(join(data, 'sipges.db'), tenantTables);
  const uploads = join(data, 'uploads');
  const files: Record<string, string> = {
    'abc_a.txt': 'a',
    'abc b ñ.txt': 'espacio',
    [`${'L'.repeat(181)}.txt`]: 'largo',
    '-.raro': 'guion',
    'sha-mal.txt': 'bytes',
    'vacio.txt': '',
    'con-sha-raro.txt': 'x',
  };
  for (const [name, content] of Object.entries(files)) writeFileSync(join(uploads, name), content);
  writeFileSync(join(uploads, 'fuera.txt'), 'fuera');
  symlinkSync(join(uploads, 'fuera.txt'), join(uploads, 'enlace.txt'));
  mkdirSync(join(uploads, 'carpeta.txt'));

  insert(db, 'records', [
    ['Eventos', 'EV-1', '{"a":1}', NOW, NOW],
    ['Eventos', 'EV-2', blob('{"é":"ñ 😀","b":[1,2.50,-0,1e21,1.5e-7,1e400,12345678901234567890]}'), NOW, NOW],
    ['Eventos', 'EV-3', '{"b":1,"a":2,"b":3,"2":0,"1":0,"01":0,"__proto__":{"x":1},"constructor":null}', NOW, NOW],
    ['Eventos', 'EV-4', '{"lone":"\\ud83d","key\\ud800":1,"ok":"\\ud83d\\ude00","ctl":"\\u0001\\u007f\\u2028\\"\\\\\\/\\b\\f\\n\\r\\t"}', NOW, NOW],
    ['Eventos', 'EV-5', ' \n{"espacio":true}\t', 1_790_000_000, 1_790_000_000.5],
    ['Eventos', 'EV-6', '[1]', NOW, NOW],
    ['Eventos', 'EV-7', 'null', NOW, NOW],
    ['Eventos', 'EV-8', '"texto"', NOW, NOW],
    ['Eventos', 'EV-9', '{"n":"a\\u0000b"}', NOW, NOW],
    ['Eventos', 'EV-10', '{"a\\u0000":1}', NOW, NOW],
    ['Eventos', 'EV-11', '{"a":[{"b":["\\u0000"]}]}', NOW, NOW],
    ['Eventos', 'EV-12', null, NOW, NOW],
    ['Eventos', 'EV-13', '{bad', NOW, NOW],
    ['Eventos', 'EV-14', '﻿{}', NOW, NOW],
    ['Eventos', 'EV-15', blob('{"x":"\xff"}'), NOW, NOW],
    ['Eventos', 'EV-16', '{}', 'ayer', NOW],
    ['Eventos', 'EV-17', '{}', NOW, null],
    ['Eventos', 'x'.repeat(200), '{}', NOW, NOW],
    ['Eventos', 'x'.repeat(201), '{}', NOW, NOW],
    ['Eventos', 'é'.repeat(201), '{}', NOW, NOW],
    ['Eventos', '', '{}', NOW, NOW],
    ['', 'SIN-MODULO', '{}', NOW, NOW],
    [null, 'NULO', '{}', NOW, NOW],
    ['Eve\0ntos', 'NUL-1', '{}', NOW, NOW],
    ['Eventos', 'NUL\0-2', '{}', NOW, NOW],
    ['Modulo Libre', 7, '{}', NOW, NOW],
    [99, 7.5, '{}', NOW, NOW],
    [blob('Blob'), blob('id-blob'), '{}', NOW, NOW],
    [blob('\xff'), blob('\xff\x61'), 'no', NOW, NOW],
    ...HOSTILE_TIMESTAMPS.map((at, i): Cell[] => ['Fechas', `F-${i}`, `{"i":${i}}`, at, NOW]),
  ]);

  insert(db, 'audit', [
    ...HOSTILE_TIMESTAMPS.map((ts, i): Cell[] => [i + 1, ts, 'Fechas', `F-${i}`, 'CREATE', `fecha ${i}`]),
    [100, NOW, null, null, 'X', null],
    [101, NOW, 'M', null, null, null],
    [102, NOW, 'M\0', null, 'X', null],
    [103, NOW, 'M', 'r\0', 'X', null],
    [104, NOW, 'M', null, 'X', 'd\0'],
    [105, NOW, '', '', '', ''],
    [106, NOW, 5, 6, 7.5, blob('detalle')],
  ]);

  insert(db, 'irsa_snapshots', [
    [1, NOW, 42.5, 'A', '{"G":40}', '0.4', 'n'],
    [2, NOW, '42.5', 'A', '{"z":1,"a":2,"1":3}', null, null],
    [3, NOW, ' 0x10 ', 'A', '{}', null, null],
    [4, NOW, '1e3', 'A', '{}', null, null],
    [5, NOW, 'Infinity', 'A', '{}', null, null],
    [6, NOW, '', 'A', '{}', null, null],
    [7, NOW, '  ', 'A', '{}', null, null],
    [8, NOW, null, 'A', '{}', null, null],
    [9, NOW, Number.POSITIVE_INFINITY, 'A', '{}', null, null],
    [10, NOW, blob('5'), 'A', '{}', null, null],
    [11, NOW, 1, null, '{}', null, null],
    [12, NOW, 1, 'A', '[1]', null, null],
    [13, NOW, 1, 'A', 'x', null, null],
    [14, 'ayer', 1, 'A', '{}', null, null],
    [15, NOW, 1, 'A\0', '{}', null, null],
    [16, NOW, 1, 'A', '{}', 'v\0', null],
    [17, NOW, 1, 'A', '{}', null, 'n\0'],
    [18, NOW, 1e21, 'A', '{"lone":"\\ud800"}', null, null],
    [19, NOW, -0.0, 'A', '{}', null, null],
    [20, NOW, 0.1, 'A', '{"e":1e400}', null, null],
    [21, NOW, '.5', 'A', '{}', null, null],
    [22, NOW, '5.', 'A', '{}', null, null],
    [23, NOW, '+5', 'A', '{}', null, null],
    [24, NOW, '0b11', 'A', '{}', null, null],
    [25, NOW, '0o17', 'A', '{}', null, null],
    [26, NOW, '-0x10', 'A', '{}', null, null],
    [27, NOW, '1_000', 'A', '{}', null, null],
  ]);

  const bytes = (text: string) => Buffer.byteLength(text);
  insert(db, 'attachments', [
    attachment('ADJ-1', 'abc_a.txt', { sha: SHA_A, at: '2026-01-01' }),
    attachment('ADJ-2', 'abc b ñ.txt', { size: 3, at: '2026-01-02', type: null, name: null }),
    attachment('ADJ-3', `${'L'.repeat(181)}.txt`, { at: '2026-01-03', sha: sha('largo'), size: bytes('largo') }),
    attachment('ADJ-4', '-.raro', { at: '2026-01-04', type: '', module: ' EVENTOS ' }),
    attachment('ADJ-5', 'sha-mal.txt', { at: '2026-01-05', sha: SHA_A }),
    attachment('ADJ-6', 'vacio.txt', { at: '2026-01-06' }),
    attachment('ADJ-7', 'con-sha-raro.txt', { at: '2026-01-07', sha: 'ABC' }),
    attachment('ADJ-8', 'no-esta.txt', { at: '2026-01-08' }),
    attachment('ADJ-9', 'enlace.txt', { at: '2026-01-09' }),
    attachment('ADJ-10', 'carpeta.txt', { at: '2026-01-10' }),
    attachment('ADJ-11', '../fuera.txt', { at: '2026-01-11' }),
    attachment('ADJ-12', 'a\\b.txt', { at: '2026-01-12' }),
    attachment('ADJ-13', 'a..b.txt', { at: '2026-01-13' }),
    attachment('ADJ-14', '.', { at: '2026-01-14' }),
    attachment('ADJ-15', 'n\0l.txt', { at: '2026-01-15' }),
    attachment('ADJ-16', 'abc_a.txt', { at: '2026-01-16', module: 'desconocido' }),
    attachment('ADJ-17', 'abc_a.txt', { at: '2026-01-17', module: 'constructor' }),
    attachment('ADJ-18', 'abc_a.txt', { at: '2026-01-18', record: 'NO-EXISTE' }),
    attachment('ADJ-19', 'abc_a.txt', { at: '2026-01-19', size: 0 }),
    attachment('ADJ-20', 'abc_a.txt', { at: '2026-01-20', size: 1.5 }),
    attachment('ADJ-21', 'abc_a.txt', { at: '2026-01-21', size: '3' }),
    attachment('ADJ-22', 'abc_a.txt', { at: '2026-01-22', size: 'x' }),
    attachment('ADJ-23', 'abc_a.txt', { at: 'ayer' }),
    attachment('ADJ-24', 'abc_a.txt', { at: '2026-01-24', type: 'tipo\0' }),
    attachment('ADJ-25', 'abc_a.txt', { at: '2026-01-25', record: 'EV-1', module: 'actores' }),
    attachment(null, 'abc_a.txt', { at: '2026-01-26' }),
    attachment('', 'abc_a.txt', { at: '2026-01-27' }),
    attachment('ADJ\0', 'abc_a.txt', { at: '2026-01-28' }),
    attachment('ADJ-29', null, { at: '2026-01-29' }),
    attachment('ADJ-30', 'abc_a.txt', { at: '2026-01-30', record: null }),
    attachment(blob('ADJ-31'), 'abc_a.txt', { at: '2026-01-31', size: -1 }),
  ]);

  insert(db, 'document_review', [
    ['DOC-1', null, null, SHA_A, null, null, null, null, 'pendiente', null, null, NOW, NOW],
    ['DOC-2', 'P', 'f', SHA_A, 'l', 't', 'e', 'a', 'descartado', 'r', 'n', '2026-01-01', '2026-01-02'],
    ['DOC-3', 'P', 'f', 'corto', 'l', 't', 'e', 'a', 'pendiente', 'r', 'n', NOW, NOW],
    ['DOC-4', 'P', 'f', SHA_A, 'l', 't', 'e', 'a', 'otro', 'r', 'n', NOW, NOW],
    ['DOC-5', 'P', 'f\0', SHA_A, 'l', 't', 'e', 'a', 'pendiente', 'r', 'n', NOW, NOW],
    ['DOC-6', 'P', 'f', SHA_A.toUpperCase(), 'l', 't', 'e', 'a', 'pendiente', 'r', 'n', NOW, NOW],
    [null, 'P', 'f', SHA_A, 'l', 't', 'e', 'a', 'pendiente', 'r', 'n', NOW, NOW],
    ['DOC-8', 'P', 'f', `${SHA_A}\n`, 'l', 't', 'e', 'a', 'pendiente', 'r', 'n', 'ayer', NOW],
  ]);

  const alert = (id: Cell, overrides: Partial<Record<'score' | 'themes' | 'signals' | 'suggestions' | 'semantic' | 'status' | 'note' | 'reviewed' | 'sha' | 'at', Cell>> = {}): Cell[] => [
    id,
    null,
    overrides.at === undefined ? NOW : overrides.at,
    null,
    null,
    null,
    overrides.sha === undefined ? SHA_A : overrides.sha,
    null,
    overrides.score === undefined ? 45 : overrides.score,
    null,
    overrides.themes === undefined ? '[]' : overrides.themes,
    overrides.signals === undefined ? '{"z":1,"a":[]}' : overrides.signals,
    overrides.suggestions === undefined ? 'null' : overrides.suggestions,
    overrides.semantic === undefined ? null : overrides.semantic,
    overrides.status === undefined ? 'Corroborado' : overrides.status,
    null,
    overrides.note === undefined ? null : overrides.note,
    overrides.reviewed === undefined ? null : overrides.reviewed,
  ];
  insert(db, 'digital_alert_reviews', [
    alert('AL-1', { at: '2026-01-01' }),
    alert('AL-2', { at: '2026-01-02', score: 45.9, semantic: 1, reviewed: NOW, note: 'nota' }),
    alert('AL-3', { at: '2026-01-03', score: -0.5, semantic: 'true', reviewed: '  ' }),
    alert('AL-4', { at: '2026-01-04', score: '12', reviewed: 5 }),
    alert('AL-5', { at: '2026-01-05', score: 'x', themes: '"texto"', signals: '5', suggestions: 'true' }),
    alert('AL-6', { at: '2026-01-06', themes: 'mal' }),
    alert('AL-7', { at: '2026-01-07', signals: null }),
    alert('AL-8', { at: '2026-01-08', suggestions: '["a\\u0000"]' }),
    alert('AL-9', { at: '2026-01-09', reviewed: 'ayer' }),
    alert('AL-10', { at: '2026-01-10', status: 'Otro' }),
    alert('AL-11', { at: '2026-01-11', sha: 'x' }),
    alert('AL-12', { at: '2026-01-12', note: 'r\0' }),
    alert('AL-13', { at: 'ayer' }),
    alert('', { at: '2026-01-14' }),
    alert('AL-15', { at: '2026-01-15', themes: `[${'['.repeat(5000)}${']'.repeat(5000)}]` }),
  ]);

  const action = (id: Cell, alertId: Cell, due: Cell, status: Cell, progress: Cell, at: string): Cell[] => [
    id, null, alertId, null, null, due, null, status, progress, at, at,
  ];
  insert(db, 'preventive_actions', [
    action('ACC-1', 'AL-1', '2026-11-15', 'Pendiente', 0, '2026-01-01'),
    action('ACC-2', 'AL-2', '2026-11-15', 'En ejecución', 100, '2026-01-02'),
    action('ACC-3', 'AL-2', '2026-11-15', 'Completada', '40', '2026-01-03'),
    action('ACC-4', 'AL-2', '2026-02-31', 'Cancelada', 40.0, '2026-01-04'),
    action('ACC-5', 'AL-6', '2026-11-15', 'Pendiente', 1, '2026-01-05'),
    action('ACC-6', 'AL-1', 'mañana', 'Pendiente', 1, '2026-01-06'),
    action('ACC-7', 'AL-1', '2026-11-15', 'Otro', 1, '2026-01-07'),
    action('ACC-8', 'AL-1', '2026-11-15', 'Pendiente', 101, '2026-01-08'),
    action('ACC-9', 'AL-1', '2026-11-15', 'Pendiente', -1, '2026-01-09'),
    action('ACC-10', 'AL-1', '2026-11-15', 'Pendiente', 1.5, '2026-01-10'),
    action('', 'AL-1', '2026-11-15', 'Pendiente', 1, '2026-01-11'),
    action('ACC-12', null, '2026-11-15', 'Pendiente', null, '2026-01-12'),
    action('ACC-13', 'AL-1', '2026-11-15\n', 'Pendiente', null, '2026-01-13'),
  ]);

  insert(db, 'preventive_action_log', [
    ['LOG-1', 'ACC-1', '2026-01-01', 'Pendiente', 0, null, null],
    ['LOG-2', 'ACC-2', '2026-01-02', 'libre', 50, 'nota', 'https://example.test'],
    ['LOG-3', 'ACC-5', '2026-01-03', 'Pendiente', 1, null, null],
    ['LOG-4', 'ACC-1', '2026-01-04', '', 1, null, null],
    ['LOG-5', 'ACC-1', '2026-01-05', 'x', 101, null, null],
    ['LOG-6', 'ACC-1', '2026-01-06', 'x', 1, 'n\0', null],
    ['LOG-7', 'ACC-1', 'ayer', 'x', 1, null, null],
  ]);
  db.close();
  writeFileSync(join(data, 'irsa_config.json'), '{"version":"0.4","pesos":{"G":1.50,"A":1e400},"z":"\\ud800","2":1,"1":2}');
};

/** A tenant with odd paths, its own settings and a stored value PostgreSQL refuses. */
const buildTenantRefused = (data: string, tenant: string) => {
  const db = open(join(data, 'tenants', `${digest(tenant)}.db`), tenantTables);
  insert(db, 'records', [['Eventos', 'EV-A', '{"lone":"\\ud800"}', NOW, NOW]]);
  db.close();
};

const buildTenantYearTooLarge = (data: string, tenant: string) => {
  const db = open(join(data, 'tenants', `${digest(tenant)}.db`), tenantTables);
  insert(db, 'records', [['Eventos', 'EV-Y', '{}', '+012026-10-01T00:00:00', NOW]]);
  db.close();
};

const buildTenantScoreTooLarge = (data: string, tenant: string) => {
  const db = open(join(data, 'tenants', `${digest(tenant)}.db`), tenantTables);
  insert(db, 'digital_alert_reviews', [
    ['AL-X', null, NOW, null, null, null, SHA_A, null, 1e21, null, '[]', '[]', '[]', 0, 'Corroborado', null, null, null],
  ]);
  db.close();
};

const buildTenantOwnSettings = (data: string, tenant: string, settings: string | null) => {
  const db = open(join(data, 'tenants', `${digest(tenant)}.db`), ['records']);
  db.close();
  const folder = join(data, 'tenants', `${digest(tenant)}_settings`);
  mkdirSync(folder, { recursive: true });
  if (settings === null) mkdirSync(join(folder, 'irsa_config.json'));
  else writeFileSync(join(folder, 'irsa_config.json'), settings);
};

/** The whole hostile installation under `root`. */
export const buildHostileInstallation = (root: string) => {
  const data = join(root, 'data');
  mkdirSync(join(data, 'tenants'), { recursive: true });
  mkdirSync(join(data, 'uploads'), { recursive: true });
  const refused = 'ACME/PRJ-LONE';
  const year = 'ACME/PRJ-YEAR';
  const score = 'ACME/PRJ-SCORE';
  buildAuth(data, [
    ['SIPGES', 'PRJ-SECHURA', 'Etiqueta "con" comillas\n'],
    ['ACME', 'PRJ-B', null],
    ['ACME', 'PRJ-LONE', 'ñ'],
    ['ACME', 'PRJ-SIN-BASE', 'sin archivo'],
    ['ACME', 'PRJ-YEAR', 'año fuera de rango'],
    ['ACME', 'PRJ-SCORE', 'puntaje enorme'],
    ['ACME', 'PRJ-CONFIG-MALA', ''],
    ['ACME', 'PRJ-CONFIG-LISTA', ''],
    ['ACME', 'PRJ-CONFIG-CARPETA', ''],
    ['ACME', 'PRJ-CONFIG-NUL', ''],
    ['', 'PRJ-VACIO', ''],
    ['ACME', null, ''],
    ['AC\0ME', 'PRJ-NUL', ''],
    ['ACME', 'PRJ\0NUL', ''],
    ['ACME', 'PRJ-ETIQUETA', 'a\0b'],
    [blob('BLOB'), 'PRJ-B', ''],
    [7, 8.5, 9],
  ]);
  buildDefaultTenant(data);
  buildTenantRefused(data, refused);
  buildTenantYearTooLarge(data, year);
  buildTenantScoreTooLarge(data, score);
  buildTenantOwnSettings(data, 'ACME/PRJ-CONFIG-MALA', '{mal');
  buildTenantOwnSettings(data, 'ACME/PRJ-CONFIG-LISTA', '[1]');
  buildTenantOwnSettings(data, 'ACME/PRJ-CONFIG-CARPETA', null);
  buildTenantOwnSettings(data, 'ACME/PRJ-CONFIG-NUL', '{"a\\u0000":1}');
  const empty = open(join(data, 'tenants', `${digest('ACME/PRJ-B')}.db`), ['records']);
  empty.close();
};

/** A copy of `source` one test can damage. */
export const buildPoisoned = (root: string, source: string) => {
  cpSync(source, root, { recursive: true });
};
