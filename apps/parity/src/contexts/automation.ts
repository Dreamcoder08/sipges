import type { ParityCase } from '../types.ts';

/**
 * Automation (T31 reads, T42 writes, below): GET /system/automations (rules, channels, latest runs), GET
 * /system/automations/runs and the inbox, GET /system/notifications. Rows go straight into
 * DEFAULT_TENANT and OTHER_TENANT (see ../fixtures.ts): rules and channels (a disabled rule, an
 * evaluate, a notify and a channel step), a delivered and a retrying run (the retrying one about
 * a record marked 'restringido', whose detail both APIs blank), and notifications of every
 * marking, one about a digital alert and one read by `consulta` and `multi`. OTHER_TENANT's rows
 * reuse the names and carry "AJENA", so a leak is plain in a mismatch report. Ids come from the
 * identity columns and rows are found by name, so the seed does not depend on any other
 * context's rows; ON CONFLICT keeps it idempotent.
 */
const SECHURA = 'SIPGES/PRJ-SECHURA';
const OTHER = 'PARITY/OTRO';

const rule = (tenant: string, name: string) =>
  `(SELECT id FROM automation_rules WHERE tenant_id = '${tenant}' AND name = '${name}')`;
const channel = (tenant: string, name: string) =>
  `(SELECT id FROM integration_channels WHERE tenant_id = '${tenant}' AND name = '${name}')`;
const notification = (tenant: string, title: string) =>
  `(SELECT id FROM notifications WHERE tenant_id = '${tenant}' AND title = '${title}')`;

const tenantRows = (tenant: string, tag: string) => `
INSERT INTO integration_channels (tenant_id, kind, name, target_hint, sealed_config, created_by, created_at)
VALUES ('${tenant}', 'webhook', 'Webhook paridad', 'hooks.example.org${tag}', 'sellado-sintetico', 'parity${tag}',
        '2026-10-01T08:00:00.5Z'),
       ('${tenant}', 'slack', 'Canal paridad', 'hooks.slack.com', 'sellado-sintetico', 'parity${tag}',
        '2026-10-01T08:00:00Z')
ON CONFLICT (tenant_id, name) DO NOTHING;
INSERT INTO automation_rules (tenant_id, name, enabled, trigger_module, trigger_actions, conditions, actions,
  created_by, created_at, updated_at)
VALUES ('${tenant}', 'Avisos paridad', true, 'Alertas', '{CREATE,UPDATE}',
        '[{"field":"Nivel","op":"eq","value":"Alto${tag}"},{"field":"$marking","op":"neq","value":"publico"}]',
        jsonb_build_array(
          jsonb_build_object('kind', 'notify', 'title', 'Nueva {{module}}${tag}'),
          jsonb_build_object('kind', 'channel', 'channelId', ${channel(tenant, 'Webhook paridad')},
                             'title', 'Canal <ops> & "equipo"${tag}')),
        'parity${tag}', '2026-10-01T08:00:00Z', '2026-10-02T09:30:15.75Z'),
       ('${tenant}', 'Bitácora paridad', false, '*', '{DELETE}', '[]',
        '[{"kind":"evaluate","title":"Evaluar${tag}","minimumLevel":"Alta"}]',
        'parity${tag}', '2026-10-01T08:00:00Z', '2026-10-01T08:00:00Z')
ON CONFLICT (tenant_id, name) DO NOTHING;
INSERT INTO automation_runs (tenant_id, rule_id, audit_id, action_index, kind, status, attempts, next_attempt_at,
  last_error, event, created_at, finished_at)
VALUES ('${tenant}', ${rule(tenant, 'Avisos paridad')}, 900001, 0, 'notify', 'done', 1, '2026-10-03T10:00:00Z', '',
        '{"auditId":900001,"at":"2026-10-03T09:59:30.120Z","module":"Alertas","recordId":"PARITY-AL-1","action":"CREATE","detail":"Alerta creada${tag}","record":{"payload":{"Nivel":"Alto"},"marking":"interno"}}',
        '2026-10-03T10:00:00Z', '2026-10-03T10:00:05.9Z'),
       ('${tenant}', ${rule(tenant, 'Avisos paridad')}, 900002, 1, 'channel', 'pending', 2, '2026-10-04T10:05:00Z',
        'HTTP 503${tag}',
        '{"auditId":900002,"at":"2026-10-04T09:59:00.000Z","module":"Alertas","recordId":"PARITY-AL-2","action":"UPDATE","detail":"Detalle reservado${tag}","record":{"payload":{},"marking":"restringido"}}',
        '2026-10-04T10:00:00Z', NULL),
       ('${tenant}', ${rule(tenant, 'Bitácora paridad')}, 900003, 0, 'evaluate', 'failed', 5, '2026-10-05T00:00:00Z',
        'Sin evaluación${tag}',
        '{"auditId":900003,"at":"2026-10-05T00:00:00Z","module":"Narrativas","recordId":null,"action":"DELETE","detail":"Eliminada${tag}","record":null}',
        '2026-10-05T00:00:00Z', '2026-10-05T00:30:00Z')
ON CONFLICT DO NOTHING;
INSERT INTO notifications (tenant_id, title, body, module, record_id, marking, rule_id, created_at)
VALUES ('${tenant}', 'Nueva Alertas${tag}', 'Alerta creada', 'Alertas', 'PARITY-AL-1', 'interno',
        ${rule(tenant, 'Avisos paridad')}, '2026-10-03T10:00:01Z'),
       ('${tenant}', 'Aviso reservado${tag}', 'Registro reservado', 'Actores', 'PARITY-A-9', 'restringido',
        ${rule(tenant, 'Avisos paridad')}, '2026-10-03T11:00:00Z'),
       ('${tenant}', 'Alerta digital${tag}', '', 'InteligenciaDigital', 'DA 1/2·ñ', 'publico', NULL,
        '2026-10-03T12:00:00.999Z'),
       ('${tenant}', 'Aviso del sistema${tag}', 'Sin registro', NULL, NULL, 'interno', NULL, '2026-10-03T13:00:00Z'),
       ('${tenant}', 'Módulo sin pantalla${tag}', 'Vínculo', 'Vinculos', 'PARITY-V-1', 'interno', NULL,
        '2026-10-03T14:00:00Z')
ON CONFLICT DO NOTHING;
INSERT INTO notification_reads (tenant_id, notification_id, username, read_at)
VALUES ('${tenant}', ${notification(tenant, `Nueva Alertas${tag}`)}, 'parity-consulta', '2026-10-05T00:00:00Z'),
       ('${tenant}', ${notification(tenant, `Alerta digital${tag}`)}, 'parity-multi', '2026-10-05T00:00:00Z')
ON CONFLICT DO NOTHING;`;

/** The latest attempt GET /system/automations/runtime shows; PARITY/PRJ-B has none. */
const attemptRows = (tenant: string, tag: string) => `
INSERT INTO automation_cursors (tenant_id, last_tick_started_at, last_tick_finished_at, last_tick_source,
  last_tick_status, last_tick_report, last_tick_error)
VALUES ('${tenant}', '2026-10-06T10:00:00.5Z', '2026-10-06T10:00:02Z', 'cron', 'completed',
        '{"tenants":1,"scanned":4,"queued":2,"executed":2,"failed":0}', 'Aviso${tag}')
ON CONFLICT (tenant_id) DO NOTHING;`;

export const seed =
  tenantRows(SECHURA, '') +
  tenantRows(OTHER, ' AJENA') +
  attemptRows(SECHURA, '') +
  attemptRows(OTHER, ' AJENA');

const scopeCases = (route: string, path: string): ParityCase[] => [
  { name: `${route}`, method: 'GET', path, auth: 'admin' },
  { name: `${route} without a session`, method: 'GET', path },
  {
    name: `${route} with an unknown session`,
    method: 'GET',
    path,
    headers: { cookie: `sipges_session=${'0'.repeat(64)}` },
  },
  { name: `${route} read-only role`, method: 'GET', path, auth: 'consulta' },
  {
    name: `${route} of a project without a grant`,
    method: 'GET',
    path,
    auth: 'admin',
    headers: { 'x-sipges-scope': 'PARITY/PRJ-B' },
  },
  {
    name: `${route} of the ungranted fixture project`,
    method: 'GET',
    path,
    auth: 'multi',
    headers: { 'x-sipges-scope': 'PARITY/OTRO' },
  },
  {
    name: `${route} with project_id of another project`,
    method: 'GET',
    path: `${path}?project_id=PRJ-B`,
    auth: 'admin',
  },
  {
    name: `${route} with project_id of its project`,
    method: 'GET',
    path: `${path}?project_id=PRJ-SECHURA`,
    auth: 'admin',
  },
  { name: `${route} before choosing a project`, method: 'GET', path, auth: 'multi' },
  {
    name: `${route} of the second project`,
    method: 'GET',
    path,
    auth: 'multi',
    headers: { 'x-sipges-scope': 'PARITY/PRJ-B' },
  },
  {
    name: `${route} of the first project by a two-project user`,
    method: 'GET',
    path,
    auth: 'multi',
    headers: { 'x-sipges-scope': 'SIPGES/PRJ-SECHURA' },
  },
  { name: `${route} with a trailing slash`, method: 'GET', path: `${path}/`, auth: 'admin' },
  { name: `${route} HEAD`, method: 'HEAD', path, auth: 'admin' },
];

/** Limits both routes clamp (runs to 1–200, the inbox to 1–100) and the values that are no integer. */
const limitCases = (route: string, path: string, auth: 'admin' | 'consulta'): ParityCase[] => [
  ...['1', '2', '0', '-3', '%20%2B2%20', '007', '99999999999999999999', '1&limit=abc'].map(
    (limit): ParityCase => ({
      name: `${route} limit=${limit}`,
      method: 'GET',
      path: `${path}?limit=${limit}`,
      auth,
    }),
  ),
  ...['abc', '1.5', '', '1e2', '--1', '0x10', '%EF%BC%91'].map((limit): ParityCase => ({
    name: `${route} limit=${limit} (422)`,
    method: 'GET',
    path: `${path}?limit=${limit}`,
    auth,
  })),
];

/** A rule both APIs can create side by side: paused, so it never matches another case's event. */
const newRule = (name: string) => ({
  name,
  enabled: false,
  module: 'Eventos',
  actions: ['CREATE'],
  conditions: [{ field: 'Nivel', op: 'eq', value: 'Alto' }],
  steps: [{ kind: 'notify', title: 'Paridad {id}' }],
});

const ruleWrite = (name: string, json: unknown, extra: Partial<ParityCase> = {}): ParityCase => ({
  name: `automation rule write ${name}`,
  method: 'POST',
  path: '/system/automations/rules',
  auth: 'admin',
  sameOrigin: true,
  body: { json },
  ...extra,
});

const channelWrite = (name: string, json: unknown): ParityCase => ({
  name: `automation channel write ${name}`,
  method: 'POST',
  path: '/system/automations/channels',
  auth: 'admin',
  sameOrigin: true,
  body: { json },
});

/**
 * Writes (T42): every refusal (schema 422s in Zod's words, rule and channel errors, missing ids,
 * role gate, Origin, project scope), a rule created by each API under a name of its own, marking
 * notifications read, the project's tick and the cron's bearer check. Channel creation needs
 * SIPGES_DATA_KEY, which the runner gives the TypeScript API only, so only its refusals run here.
 */
const writeCases: ParityCase[] = [
  ruleWrite('by the read-only role', {}, { auth: 'consulta' }),
  {
    name: 'automation rule write without a session',
    method: 'POST',
    path: '/system/automations/rules',
    sameOrigin: true,
    body: { json: newRule('x') },
  },
  {
    name: 'automation rule write without Origin',
    method: 'POST',
    path: '/system/automations/rules',
    auth: 'admin',
    body: { json: newRule('x') },
  },
  ruleWrite('before choosing a project', newRule('x'), { auth: 'multi' }),
  ruleWrite('naming another project', { ...newRule('x'), project_id: 'PRJ-B' }),
  ruleWrite('creates a paused rule', newRule('{rule}'), {
    vary: { rule: { ts: 'Regla paridad TS', go: 'Regla paridad Go' } },
    normalize: ['id'],
  }),
  ruleWrite('with a duplicate name', newRule('Avisos paridad')),
  ruleWrite('with an unknown module', { ...newRule('x'), module: 'Desconocido' }),
  ruleWrite('with an unknown action', { ...newRule('x'), actions: ['BORRAR'] }),
  ruleWrite('with an invalid condition field', {
    ...newRule('x'),
    conditions: [{ field: 'campo:x', op: 'eq' }],
  }),
  ruleWrite('evaluating outside Narrativas', {
    ...newRule('x'),
    steps: [{ kind: 'evaluate', title: 't', minimum_level: 'Alta' }],
  }),
  ruleWrite('to a missing channel', {
    ...newRule('x'),
    steps: [{ kind: 'channel', channel_id: 999999, title: 't' }],
  }),
  ruleWrite('with an empty body', {}),
  ruleWrite('that is not an object', [1, 2]),
  { ...ruleWrite('that is not JSON', null), body: { raw: '{"name":' } },
  ruleWrite('with every field wrong', {
    name: '  ',
    enabled: 'si',
    module: 'x'.repeat(61),
    actions: Array(11).fill('CREATE'),
    conditions: [{ field: '', op: 'like', value: 5 }, null],
    steps: [{ kind: 'otro' }, { kind: 'channel', channel_id: 1.5, title: '' }, { kind: 'notify' }],
  }),
  ruleWrite('with a NUL in its name and an emoji-long title', {
    ...newRule('a\u0000b'),
    steps: [{ kind: 'notify', title: '😀'.repeat(201) }],
  }),
  {
    name: 'automation rule update with a non-numeric id',
    method: 'PUT',
    path: '/system/automations/rules/abc',
    auth: 'admin',
    sameOrigin: true,
    body: { json: newRule('x') },
  },
  {
    name: 'automation rule update of a missing rule',
    method: 'PUT',
    path: '/system/automations/rules/999999',
    auth: 'admin',
    sameOrigin: true,
    body: { json: newRule('Regla inexistente') },
  },
  {
    name: 'automation rule delete of a missing rule',
    method: 'DELETE',
    path: '/system/automations/rules/999999',
    auth: 'admin',
    sameOrigin: true,
  },
  {
    name: 'automation rule delete with a ten-digit id',
    method: 'DELETE',
    path: '/system/automations/rules/1234567890',
    auth: 'admin',
    sameOrigin: true,
  },
  channelWrite('to the wrong host', {
    kind: 'slack',
    name: 'x',
    settings: { url: 'https://evil.example.org/x' },
  }),
  channelWrite('to a private host', {
    kind: 'webhook',
    name: 'x',
    settings: { url: 'https://10.0.0.1/x', secret: 's'.repeat(24) },
  }),
  channelWrite('over http', {
    kind: 'teams',
    name: 'x',
    settings: { url: 'http://example.org/x' },
  }),
  channelWrite('with a short secret', {
    kind: 'webhook',
    name: 'x',
    settings: { url: 'https://hooks.example.org/x', secret: 'corto' },
  }),
  channelWrite('with a bad telegram token', {
    kind: 'telegram',
    name: 'x',
    settings: { bot_token: 'x', chat_id: '1' },
  }),
  channelWrite('with a bad e-mail list', {
    kind: 'email',
    name: 'x',
    settings: { api_key: `re_${'a'.repeat(12)}`, from: 'avisos@example.org', to: 'no-es-correo' },
  }),
  channelWrite('of an unknown kind', { kind: 'fax', name: 5, settings: [] }),
  channelWrite('with mixed settings', {
    kind: 'slack',
    name: 'x',
    settings: { 10: 5, b: 'ok', 2: 'x'.repeat(1001), a: [1] },
  }),
  {
    name: 'automation channel write by the read-only role',
    method: 'POST',
    path: '/system/automations/channels',
    auth: 'consulta',
    sameOrigin: true,
    body: { json: {} },
  },
  {
    name: 'automation channel delete of a missing channel',
    method: 'DELETE',
    path: '/system/automations/channels/999999',
    auth: 'admin',
    sameOrigin: true,
  },
  {
    name: 'automation channel test with a non-numeric id',
    method: 'POST',
    path: '/system/automations/channels/x/test',
    auth: 'admin',
    sameOrigin: true,
  },
  {
    name: 'automation channel test of a missing channel',
    method: 'POST',
    path: '/system/automations/channels/999999/test',
    auth: 'admin',
    sameOrigin: true,
  },
  ...[
    { all: true },
    { ids: [1, 2] },
    { ids: [] },
    { ids: [0] },
    { ids: [1.5] },
    { all: false },
    {},
  ].map((json): ParityCase => ({
    name: `automation notifications read ${JSON.stringify(json)}`,
    method: 'POST',
    path: '/system/notifications/read',
    auth: 'consulta',
    sameOrigin: true,
    body: { json },
  })),
  {
    name: 'automation tick of the project',
    method: 'POST',
    path: '/system/automations/tick',
    auth: 'admin',
    sameOrigin: true,
    // Both ticks run at once on one database: which one queues or delivers a run differs.
    normalize: ['scanned', 'queued', 'delivered', 'retrying', 'failed'],
  },
  {
    name: 'automation tick by the read-only role',
    method: 'POST',
    path: '/system/automations/tick',
    auth: 'consulta',
    sameOrigin: true,
  },
  { name: 'automation cron without a bearer', method: 'POST', path: '/system/automations/cron' },
  {
    name: 'automation cron with a bearer when no secret is configured',
    method: 'GET',
    path: '/system/automations/cron',
    headers: { authorization: `Bearer ${'s'.repeat(32)}` },
  },
];

export const cases: readonly ParityCase[] = [
  ...scopeCases('automation overview', '/system/automations'),
  ...scopeCases('automation runtime', '/system/automations/runtime'),
  ...scopeCases('automation runs', '/system/automations/runs'),
  ...limitCases('automation runs', '/system/automations/runs', 'admin'),
  {
    name: 'automation runs limit=abc for the read-only role (role gate first)',
    method: 'GET',
    path: '/system/automations/runs?limit=abc',
    auth: 'consulta',
  },
  ...scopeCases('automation inbox', '/system/notifications'),
  ...limitCases('automation inbox', '/system/notifications', 'consulta'),
  {
    name: 'automation inbox limit=1 of the first project by a two-project user',
    method: 'GET',
    path: '/system/notifications?limit=1',
    auth: 'multi',
    headers: { 'x-sipges-scope': 'SIPGES/PRJ-SECHURA' },
  },
  ...writeCases,
];
