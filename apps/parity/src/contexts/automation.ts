import type { ParityCase } from '../types.ts';

/**
 * Automation, read-only (T31): GET /system/automations (rules, channels, latest runs), GET
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

export const seed = tenantRows(SECHURA, '') + tenantRows(OTHER, ' AJENA');

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

export const cases: readonly ParityCase[] = [
  ...scopeCases('automation overview', '/system/automations'),
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
  // Writes and the runtime stay in TypeScript; the role gate answers the same in both APIs.
  {
    name: 'automation rule write by the read-only role',
    method: 'POST',
    path: '/system/automations/rules',
    auth: 'consulta',
    sameOrigin: true,
    body: { json: {} },
  },
];
