import { createHash } from 'node:crypto';
import type { ParityCase } from '../types.ts';

/**
 * Runtime (T45): API keys with synthetic secrets stored as SHA-256 hex (keyCrypto.hash), so both
 * APIs verify the same rows: a write key, a read-only key, a revoked key and a key of
 * OTHER_TENANT; and one key per API to revoke. Feeds per API to update and delete, and a feed
 * only OTHER_TENANT holds.
 */
const secret = (letter: string) => letter.repeat(43);
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const KEYS = {
  write: ['c0ffee101001', secret('w')],
  read: ['c0ffee101002', secret('r')],
  revoked: ['c0ffee101003', secret('v')],
  other: ['c0ffee101004', secret('o')],
  revokeTs: ['c0ffee101005', secret('t')],
  revokeGo: ['c0ffee101006', secret('g')],
} as const;
const bearer = ([prefix, value]: readonly [string, string]) => `Bearer mscli_${prefix}_${value}`;
/**
 * A webhook's wakeup: one project per API, so the TypeScript API's scan can never process the Go
 * API's webhook. Each has a cursor, a rule and a write key; one account reads both, with a session
 * made here because the runner's own accounts must keep their projects.
 */
const WAKE_TOKEN = 'ab'.repeat(32);
const WAKE = {
  ts: { tenant: 'PARITY/WAKE-TS', key: ['c0ffee101007', secret('a')] },
  go: { tenant: 'PARITY/WAKE-GO', key: ['c0ffee101008', secret('b')] },
} as const;
const WAKE_TITLE = 'Webhook recibido paridad';
type WakeProject = { readonly tenant: string; readonly key: readonly [string, string] };
const wakeRows = ({ tenant, key }: WakeProject, id: number) => {
  const project = tenant.split('/')[1];
  return `
INSERT INTO tenants (company_id, project_id, label) VALUES ('PARITY', '${project}', 'Despertar');
INSERT INTO grants (username, tenant_id) VALUES ('parity-wake', '${tenant}');
INSERT INTO automation_cursors (tenant_id, last_audit_id) VALUES ('${tenant}', 0);
INSERT INTO automation_rules (tenant_id, name, enabled, trigger_module, trigger_actions, conditions,
  actions, created_by, created_at, updated_at)
VALUES ('${tenant}', 'Avisar webhooks', true, 'Narrativas', '{CREATE}', '[]',
  '[{"kind":"notify","title":"${WAKE_TITLE}"}]', 'parity', '2026-10-01T08:00:00Z', '2026-10-01T08:00:00Z');
INSERT INTO api_keys (id, tenant_id, name, prefix, secret_hash, access, clearance, created_by,
  created_at, last_used_at, revoked_at) OVERRIDING SYSTEM VALUE VALUES
  (${id}, '${tenant}', 'parity-despertar', '${key[0]}', '${sha256(key[1])}', 'write', 'full',
   'parity', '2026-10-01 00:00:00+00', NULL, NULL);`;
};
const WAKE_SEED = `
INSERT INTO users (username, full_name, password_hash, role, active, totp_enabled)
VALUES ('parity-wake', 'Paridad despertar', 'x', 'consulta', true, true);
INSERT INTO sessions (token_hash, username, expires_at)
VALUES ('${sha256(WAKE_TOKEN)}', 'parity-wake', '2099-01-01 00:00:00+00');
${wakeRows(WAKE.ts, 32107)}
${wakeRows(WAKE.go, 32108)}`;

const RUNTIME_SEED = `
INSERT INTO api_keys (id, tenant_id, name, prefix, secret_hash, access, clearance, created_by,
  created_at, last_used_at, revoked_at) OVERRIDING SYSTEM VALUE VALUES
  (32101, 'SIPGES/PRJ-SECHURA', 'parity-ingest', '${KEYS.write[0]}', '${sha256(KEYS.write[1])}',
   'write', 'full', 'parity', '2026-10-01 00:00:00+00', NULL, NULL),
  (32102, 'SIPGES/PRJ-SECHURA', 'parity-lectura', '${KEYS.read[0]}', '${sha256(KEYS.read[1])}',
   'read', 'full', 'parity', '2026-10-01 00:00:00+00', NULL, NULL),
  (32103, 'SIPGES/PRJ-SECHURA', 'parity-revocada', '${KEYS.revoked[0]}', '${sha256(KEYS.revoked[1])}',
   'write', 'full', 'parity', '2026-10-01 00:00:00+00', NULL, '2026-10-02 00:00:00+00'),
  (32104, 'PARITY/OTRO', 'parity-ajena', '${KEYS.other[0]}', '${sha256(KEYS.other[1])}',
   'write', 'full', 'AJENA', '2026-10-01 00:00:00+00', NULL, NULL),
  (32105, 'SIPGES/PRJ-SECHURA', 'parity-revocar-ts', '${KEYS.revokeTs[0]}', '${sha256(KEYS.revokeTs[1])}',
   'write', 'full', 'parity', '2026-10-01 00:00:00+00', NULL, NULL),
  (32106, 'SIPGES/PRJ-SECHURA', 'parity-revocar-go', '${KEYS.revokeGo[0]}', '${sha256(KEYS.revokeGo[1])}',
   'write', 'full', 'parity', '2026-10-01 00:00:00+00', NULL, NULL)
ON CONFLICT DO NOTHING;
INSERT INTO media_feeds (tenant_id, id, name, url, keywords, territory, authorization_note, enabled,
  updated_by, updated_at) OVERRIDING SYSTEM VALUE VALUES
  ('SIPGES/PRJ-SECHURA', 32111, 'Editar TS', 'https://editar-ts.example/rss', '[]', '', 'Nota', true,
   'parity', '2026-10-01 00:00:00+00'),
  ('SIPGES/PRJ-SECHURA', 32112, 'Editar GO', 'https://editar-go.example/rss', '[]', '', 'Nota', true,
   'parity', '2026-10-01 00:00:00+00'),
  ('SIPGES/PRJ-SECHURA', 32113, 'Borrar TS', 'https://borrar-ts.example/rss', '[]', '', 'Nota', true,
   'parity', '2026-10-01 00:00:00+00'),
  ('SIPGES/PRJ-SECHURA', 32114, 'Borrar GO', 'https://borrar-go.example/rss', '[]', '', 'Nota', true,
   'parity', '2026-10-01 00:00:00+00'),
  ('PARITY/OTRO', 32120, 'Solo AJENA', 'https://ajena.example/rss', '[]', '', 'AJENA', true,
   'AJENA', '2026-10-01 00:00:00+00')
ON CONFLICT DO NOTHING;
`;

/**
 * Integration, admin reads only (T32): API key metadata, media feeds and the authorized-source
 * catalog. The seed loads keys, feeds and Defensoría settings in the default project and in
 * OTHER_TENANT (see ../fixtures.ts); the second project keeps none, so it answers the empty
 * state. `api_keys` has no row-level security: only the tenant filter keeps PARITY/OTRO's key,
 * which reuses a default-project key name, out. Feeds reuse ids across tenants, so only RLS
 * keeps them apart. Rows of the other project carry "AJENA" so a leak is plain in a mismatch
 * report. The hashes are synthetic placeholders: no answer may contain them.
 * Ids are explicit and every insert is ON CONFLICT DO NOTHING, so the seed does not depend on
 * other contexts' seeds or their order.
 */
export const seed = `
INSERT INTO api_keys (id, tenant_id, name, prefix, secret_hash, access, clearance, created_by,
  created_at, last_used_at, revoked_at) OVERRIDING SYSTEM VALUE VALUES
  (32001, 'SIPGES/PRJ-SECHURA', 'Zeta', 'c0ffee000001', 'hash-sintetico-1', 'read', 'limited',
   'parity', '2026-10-01 08:00:00.987+00', NULL, NULL),
  (32002, 'SIPGES/PRJ-SECHURA', 'Alfa', 'c0ffee000002', 'hash-sintetico-2', 'write', 'full',
   'parity', '2026-09-01 00:00:00+00', '2026-09-02 00:00:00+00', '2026-09-03 10:11:12.5+00'),
  (32003, 'SIPGES/PRJ-SECHURA', 'Beta', 'c0ffee000003', 'hash-sintetico-3', 'write', 'full',
   'parity', '2026-10-02 00:00:00+00', '2026-10-30 12:00:00.999+00', NULL),
  (32004, 'PARITY/OTRO', 'Zeta', 'c0ffee000004', 'hash-sintetico-4', 'write', 'full',
   'AJENA', '2026-10-01 00:00:00+00', NULL, NULL)
ON CONFLICT DO NOTHING;
INSERT INTO media_feeds (tenant_id, id, name, url, keywords, territory, authorization_note, enabled,
  updated_by, updated_at, last_poll_at, last_poll_error, last_imported, last_matched)
  OVERRIDING SYSTEM VALUE VALUES
  ('SIPGES/PRJ-SECHURA', 32002, 'Diario B', 'https://example.org/b.xml', '[]', '', 'Nota', false,
   'parity', '2026-10-03 00:00:00+00', NULL, '', 0, 0),
  ('SIPGES/PRJ-SECHURA', 32001, 'Diario A', 'https://example.org/a.xml?x=1&y=<2>',
   '["agua", "minería"]', 'Costa', 'Autorizado', true, 'parity', '2026-10-01 08:00:00.123456+00',
   '2026-10-02 09:30:00.5+00', 'La fuente no respondió a tiempo.', 3, 5),
  ('PARITY/OTRO', 32001, 'Diario AJENA', 'https://example.org/ajena.xml', '["AJENA"]', '', 'AJENA',
   true, 'AJENA', '2026-10-01 00:00:00+00', NULL, '', 0, 0)
ON CONFLICT DO NOTHING;
INSERT INTO source_import_settings (tenant_id, source_id, enabled, query, territory,
  authorization_note, revision, updated_by, updated_at, last_poll_at, last_poll_error,
  last_imported, last_duplicates) VALUES
  ('SIPGES/PRJ-SECHURA', 'defensoria', true, 'agua', 'Costa', 'Convenio sintético', 3, 'parity',
   '2026-10-04 05:06:07.089+00', '2026-10-05 00:00:00+00', 'source_poll_failed', 2, 1),
  ('PARITY/OTRO', 'defensoria', true, 'AJENA', 'AJENA', 'AJENA', 9, 'AJENA',
   '2026-10-01 00:00:00+00', NULL, '', 0, 0)
ON CONFLICT DO NOTHING;
${RUNTIME_SEED}
${WAKE_SEED}`;

const API_KEYS = '/system/integrations/api-keys';

/** The cases every route shares: scope, session and project choice. */
const scoped = (label: string, path: string): ParityCase[] => [
  { name: `integration ${label}`, method: 'GET', path, auth: 'admin' },
  { name: `integration ${label} without a session`, method: 'GET', path },
  { name: `integration ${label} read-only role`, method: 'GET', path, auth: 'consulta' },
  {
    name: `integration ${label} of a project without a grant`,
    method: 'GET',
    path,
    auth: 'admin',
    headers: { 'x-sipges-scope': 'PARITY/PRJ-B' },
  },
  {
    name: `integration ${label} of the ungranted fixture project`,
    method: 'GET',
    path,
    auth: 'admin',
    headers: { 'x-sipges-scope': 'PARITY/OTRO' },
  },
  {
    name: `integration ${label} with project_id of another project`,
    method: 'GET',
    path: `${path}?project_id=OTRO`,
    auth: 'admin',
  },
  {
    name: `integration ${label} with project_id of its project`,
    method: 'GET',
    path: `${path}?project_id=PRJ-SECHURA`,
    auth: 'admin',
  },
  { name: `integration ${label} before choosing a project`, method: 'GET', path, auth: 'multi' },
  {
    name: `integration ${label} of the second project`,
    method: 'GET',
    path,
    auth: 'multi',
    headers: { 'x-sipges-scope': 'PARITY/PRJ-B' },
  },
  {
    name: `integration ${label} of the first project by a two-project user`,
    method: 'GET',
    path,
    auth: 'multi',
    headers: { 'x-sipges-scope': 'SIPGES/PRJ-SECHURA' },
  },
  {
    name: `integration ${label} with a trailing slash`,
    method: 'GET',
    path: `${path}/`,
    auth: 'admin',
  },
  { name: `integration ${label} HEAD`, method: 'HEAD', path, auth: 'admin' },
];

/** Each API's own rows of the runtime writes. */
const W = {
  w: { ts: 'TS', go: 'GO' },
  feed: { ts: '32111', go: '32112' },
  del: { ts: '32113', go: '32114' },
  revoke: { ts: '32105', go: '32106' },
  revoked: { ts: bearer(KEYS.revokeTs), go: bearer(KEYS.revokeGo) },
} as const;
const json = { 'content-type': 'application/json' };
const INGEST = '/hooks/ingest/narrativas';

/** A webhook call: no session, the API key in Authorization. */
const hook = (
  name: string,
  key: string | null,
  body: ParityCase['body'] | undefined,
  extra: Partial<ParityCase> = {},
): ParityCase => ({
  name: `integration runtime: ${name}`,
  method: 'POST',
  path: INGEST,
  vary: W,
  ...(body ? { body } : {}),
  ...extra,
  headers: { ...json, ...(key ? { authorization: key } : {}), ...(extra.headers ?? {}) },
});

/** An administrator's write in the default project, same origin. */
const admin = (
  name: string,
  method: ParityCase['method'],
  path: string,
  body?: ParityCase['body'],
  extra: Partial<ParityCase> = {},
): ParityCase => ({
  name: `integration runtime: ${name}`,
  method,
  path,
  auth: 'admin',
  sameOrigin: true,
  vary: W,
  ...(body ? { body } : {}),
  ...extra,
});

const FEEDS = '/system/v4/media/feeds';
const feed = (extra: Record<string, unknown>) => ({
  json: {
    name: 'Diario {w}',
    url: 'https://paridad-{w}.example/rss',
    authorization_note: 'Nota',
    ...extra,
  },
});
const SOURCES = '/system/intelligence/sources/defensoria';
const SECOND = { 'x-sipges-scope': 'PARITY/PRJ-B' };
const signal = (extra: Record<string, unknown>) => ({
  json: {
    source_name: 'Fuente sintética',
    source_url: 'https://fuente.example/paridad',
    external_id: 'paridad-{w}',
    text: 'Señal sintética {w}',
    observed_at: '2026-11-01T10:00:00Z',
    ...extra,
  },
});

const RUNTIME_CASES: readonly ParityCase[] = [
  // Ingest webhook: credentials first (no session, Origin or project scope applies).
  hook(
    'ingest creates a record in the key project',
    bearer(KEYS.write),
    {
      json: { ID_Narrativa: 'PARITY-ING-{w}', Descripcion: 'Ingesta sintética' },
    },
    { normalize: ['ids.*'] },
  ),
  {
    name: 'integration runtime: the ingested record is stored',
    method: 'GET',
    path: '/api/narrativas/PARITY-ING-{w}',
    auth: 'admin',
    vary: W,
    normalize: ['ID_Narrativa', '_id'],
  },
  {
    name: 'integration runtime: the ingested record history names the key',
    method: 'GET',
    path: '/api/narrativas/PARITY-ING-{w}/history',
    auth: 'admin',
    vary: W,
    normalize: ['*.at', '*.payload.ID_Narrativa', '*.changes.*.after'],
  },
  hook('ingest with a forged secret', bearer([KEYS.write[0], secret('x')]), { json: { a: 1 } }),
  hook('ingest with a revoked key', bearer(KEYS.revoked), { json: { a: 1 } }),
  hook('ingest with a read-only key', bearer(KEYS.read), { json: { a: 1 } }),
  hook('ingest without a key', null, { json: { a: 1 } }),
  hook('ingest with the Basic scheme', `Basic mscli_${KEYS.write[0]}_${KEYS.write[1]}`, {
    json: { a: 1 },
  }),
  hook('ingest with a session and no key', null, { json: { a: 1 } }, { auth: 'admin' }),
  hook('ingest by another project naming this one', bearer(KEYS.other), {
    json: { ID_Narrativa: 'PARITY-ING-AJENA-{w}', Proyecto_ID: 'PRJ-SECHURA' },
  }),
  hook(
    'ingest by another project',
    bearer(KEYS.other),
    {
      json: { ID_Narrativa: 'PARITY-ING-AJENA-{w}', Descripcion: 'AJENA' },
    },
    { normalize: ['ids.*'] },
  ),
  {
    name: "integration runtime: another project's ingested record is invisible",
    method: 'GET',
    path: '/api/narrativas/PARITY-ING-AJENA-{w}',
    auth: 'admin',
    vary: W,
  },
  hook(
    'ingest with an idempotency key',
    bearer(KEYS.write),
    { json: { ID_Narrativa: 'PARITY-IDEM-{w}' } },
    { headers: { 'idempotency-key': 'paridad-{w}' }, normalize: ['ids.*'] },
  ),
  hook(
    'ingest replays an idempotency key',
    bearer(KEYS.write),
    { json: { ID_Narrativa: 'PARITY-IDEM-{w}', Descripcion: 'otra' } },
    { headers: { 'idempotency-key': 'paridad-{w}' }, normalize: ['ids.*'] },
  ),
  hook(
    'ingest with an invalid idempotency key',
    bearer(KEYS.write),
    { json: { a: 1 } },
    { headers: { 'idempotency-key': 'con espacio' } },
  ),
  hook(
    'ingest a form',
    bearer(KEYS.write),
    {
      form: { ID_Narrativa: 'PARITY-FORM-{w}', Descripcion: 'Formulario', 'f[]': 'x' },
    },
    { normalize: ['ids.*'] },
  ),
  {
    name: 'integration runtime: the form record is stored',
    method: 'GET',
    path: '/api/narrativas/PARITY-FORM-{w}',
    auth: 'admin',
    vary: W,
    normalize: ['ID_Narrativa', '_id'],
  },
  hook(
    'ingest as text/plain',
    bearer(KEYS.write),
    { raw: '{"a":1}' },
    { headers: { 'content-type': 'text/plain' } },
  ),
  hook('ingest invalid JSON', bearer(KEYS.write), { raw: '{"a":' }),
  hook('ingest no records', bearer(KEYS.write), { json: [] }),
  hook('ingest an empty record', bearer(KEYS.write), { json: [{ a: 1 }, {}] }),
  hook(
    'ingest into an unknown module',
    bearer(KEYS.write),
    { json: { a: 1 } },
    { path: '/hooks/ingest/nada' },
  ),
  // An oversize body (413) is covered by the Go integration test: the server closes the
  // connection unread, which the runner's pooled socket cannot reuse.
  hook('ingest GET', bearer(KEYS.write), undefined, { method: 'GET' }),
  // Signals webhook.
  hook('signal becomes a narrative', bearer(KEYS.write), signal({}), {
    path: '/hooks/signals',
    normalize: ['ids.*'],
  }),
  hook('signal replayed by its fingerprint', bearer(KEYS.write), signal({}), {
    path: '/hooks/signals',
    normalize: ['ids.*'],
  }),
  hook('signal refused', bearer(KEYS.write), signal({ observed_at: '2026-11-01' }), {
    path: '/hooks/signals',
  }),
  hook('signal with a non-URL reference', bearer(KEYS.write), signal({ source_url: 'no es url' }), {
    path: '/hooks/signals',
  }),
  hook('signal with a read-only key', bearer(KEYS.read), signal({}), { path: '/hooks/signals' }),
  // No session write follows the webhook, and no other API sees its project: only its own wakeup
  // can produce the notification.
  hook(
    'a webhook wakes its project',
    '{wakeKey}',
    { json: { ID_Narrativa: 'PARITY-WAKE', Descripcion: 'Despertar' } },
    { vary: { ...W, wakeKey: { ts: bearer(WAKE.ts.key), go: bearer(WAKE.go.key) } } },
  ),
  {
    name: 'integration runtime: the woken project has its notification',
    method: 'GET',
    path: '/system/notifications',
    headers: { cookie: `sipges_session=${WAKE_TOKEN}`, 'x-sipges-scope': '{wakeScope}' },
    vary: { wakeScope: { ts: WAKE.ts.tenant, go: WAKE.go.tenant } },
    present: [WAKE_TITLE],
    eventually: true,
    normalize: ['items.*.id', 'items.*.created_at', 'items.*.link'],
  },
  // Media feeds (admin only): create, read back, update, delete, refusals.
  admin('create a media feed', 'POST', FEEDS, feed({ keywords: [' agua ', 'agua'] }), {
    normalize: ['id', 'name', 'url', 'updated_at'],
  }),
  admin('duplicate media feed', 'POST', FEEDS, feed({})),
  {
    name: 'integration runtime: media feeds after the writes',
    method: 'GET',
    path: '/system/v4/media',
    auth: 'admin',
  },
  ...[
    'http://x.example/rss',
    'https://127.0.0.1/rss',
    'https://0x7f000001/rss',
    'https://[::1]/rss',
    'https://localhost/rss',
    'https://router.local/rss',
    'https://x.example:8443/rss',
    'https://u:p@x.example/rss',
    'no es url',
  ].map((url) => admin(`media feed refused: ${url}`, 'POST', FEEDS, feed({ url }))),
  admin('media feed with missing fields', 'POST', FEEDS, { json: { name: 5 } }),
  admin('media feed oversize body', 'POST', FEEDS, { json: { name: 'x'.repeat(9000) } }),
  admin('update a media feed', 'PUT', `${FEEDS}/{feed}`, feed({ enabled: false }), {
    normalize: ['updated_at'],
  }),
  admin('update a missing media feed', 'PUT', `${FEEDS}/999999`, feed({})),
  admin('update with an invalid id', 'PUT', `${FEEDS}/abc`, feed({})),
  admin('delete a media feed', 'DELETE', `${FEEDS}/{del}`),
  admin('delete it again', 'DELETE', `${FEEDS}/{del}`),
  admin("delete another project's feed", 'DELETE', `${FEEDS}/32120`),
  {
    name: 'integration runtime: media feeds after update and delete',
    method: 'GET',
    path: '/system/v4/media',
    auth: 'admin',
    normalize: ['feeds.*.updated_at'],
  },
  {
    ...admin('media feed write by an analyst', 'POST', FEEDS, feed({})),
    auth: 'multi',
    headers: { 'x-sipges-scope': 'SIPGES/PRJ-SECHURA' },
  },
  admin('preview refused URL', 'POST', '/system/v4/media/preview', {
    json: { url: 'http://x.example/' },
  }),
  admin('preview invalid body', 'POST', '/system/v4/media/preview', { json: { keywords: 5 } }),
  admin('preview an unresolvable host', 'POST', '/system/v4/media/preview', {
    json: { url: 'https://sipges-paridad.invalid/rss' },
  }),
  {
    ...admin('media poll by the read-only role', 'POST', '/system/v4/media/poll'),
    auth: 'consulta',
  },
  // Defensoría connector: configuration in the second project, read back; refusals.
  {
    name: 'integration runtime: configure the connector',
    method: 'PUT',
    path: `${SOURCES}/config`,
    auth: 'multi',
    sameOrigin: true,
    headers: SECOND,
    body: {
      json: { enabled: true, query: ' agua ', territory: 'Costa', authorization_note: 'Convenio' },
    },
    normalize: ['revision', 'updated_at'],
  },
  {
    name: 'integration runtime: the connector configuration is stored',
    method: 'GET',
    path: '/system/intelligence/sources',
    auth: 'multi',
    headers: SECOND,
    normalize: ['state.revision', 'state.updated_at'],
  },
  {
    name: 'integration runtime: enabling without a note',
    method: 'PUT',
    path: `${SOURCES}/config`,
    auth: 'multi',
    sameOrigin: true,
    headers: SECOND,
    body: { json: { enabled: true } },
  },
  admin('connector config validation', 'PUT', `${SOURCES}/config`, {
    json: { enabled: 'si', query: 5 },
  }),
  {
    ...admin('connector config by the read-only role', 'PUT', `${SOURCES}/config`, {
      json: { enabled: false },
    }),
    auth: 'consulta',
  },
  admin('import validation', 'POST', `${SOURCES}/import`, { json: { post_id: 1.5 } }),
  admin('import without a post', 'POST', `${SOURCES}/import`, { json: {} }),
  {
    name: 'integration runtime: preview with a long query',
    method: 'GET',
    path: `${SOURCES}/preview?query=${'x'.repeat(101)}`,
    auth: 'admin',
  },
  { ...admin('connector poll by the read-only role', 'POST', `${SOURCES}/poll`), auth: 'consulta' },
  // API key revocation: audited, immediate, only in the active project.
  admin('revoke a key', 'DELETE', `${API_KEYS}/{revoke}`),
  admin('revoke it again', 'DELETE', `${API_KEYS}/{revoke}`),
  admin("revoke another project's key", 'DELETE', `${API_KEYS}/32104`),
  admin('revoke an invalid id', 'DELETE', `${API_KEYS}/abc`),
  hook('ingest with the key just revoked', '{revoked}', { json: { a: 1 } }),
  {
    name: 'integration runtime: keys after the revocation',
    method: 'GET',
    path: API_KEYS,
    auth: 'admin',
    normalize: ['*.revoked_at', '*.last_used_at'],
  },
];

export const cases: readonly ParityCase[] = [
  // Admin only: consulta and the analista (multi) get the role gate's 403.
  ...scoped('api-keys', API_KEYS),
  ...scoped('media', '/system/v4/media'),
  ...scoped('sources', '/system/intelligence/sources'),
  {
    name: 'integration media feed write by the read-only role',
    method: 'POST',
    path: '/system/v4/media/feeds',
    auth: 'consulta',
    sameOrigin: true,
    body: { json: { name: 'Feed', url: 'https://example.org/f.xml', authorization_note: 'Nota' } },
  },
  {
    name: 'integration api-key revocation by an analyst',
    method: 'DELETE',
    path: `${API_KEYS}/32001`,
    auth: 'multi',
    sameOrigin: true,
    headers: { 'x-sipges-scope': 'SIPGES/PRJ-SECHURA' },
  },
  ...RUNTIME_CASES,
];
