import type { ParityCase } from '../types.ts';

/**
 * Prevention (T19, writes T37). seed.ts creates verified alerts and plans in the default and the
 * second project through the TypeScript API; this seed adds, in OTHER_TENANT (see
 * ../fixtures.ts), a plan with the default project's project id, so only row-level security keeps
 * it out. Its rows carry "AJENA" so a leak is plain in a mismatch report.
 *
 * The runner sends each case to both APIs at the same time on one database, so a write that
 * succeeds changes rows of its own: a creation adds one plan per API, and an update names the
 * plan of its API (`perApi`), because its answer lists the history so far. Refusals write
 * nothing and share their rows. The PARITY-PREV rows belong to these cases only.
 */
const DEFAULT = 'SIPGES/PRJ-SECHURA';
const plan = (
  id: string,
  status: string,
) => `('${DEFAULT}', '${id}', 'PRJ-SECHURA', 'PARITY-PREV-W',
   'Plan de escritura', 'Equipo', '2099-01-01', '', '${status}', 10, '2026-01-02 00:00:00+00',
   '2026-01-02 00:00:00+00')`;

export const seed = `
INSERT INTO digital_alert_reviews (tenant_id, id, project_id, created_at, source_url, source_type,
  excerpt, sha256, level, score, method, themes, signals, suggestions, semantic_active, status,
  analyst_note) VALUES
  ('${DEFAULT}', 'PARITY-PREV-W', 'PRJ-SECHURA', '2026-01-02 00:00:00+00', '', 'Documento', 'Texto',
   repeat('a', 64), 'Baja', 1, 'rules', '[]', '[]', '[]', false, 'En seguimiento', ''),
  ('${DEFAULT}', 'PARITY-PREV-NEW', 'PRJ-SECHURA', '2026-01-02 00:00:00+00', '', 'Documento', 'Texto',
   repeat('a', 64), 'Baja', 1, 'rules', '[]', '[]', '[]', false, 'Descartado', ''),
  ('${DEFAULT}', 'PARITY-PREV-X', 'PRJ-AJENO', '2026-01-02 00:00:00+00', '', 'Documento', 'Texto',
   repeat('a', 64), 'Baja', 1, 'rules', '[]', '[]', '[]', false, 'En seguimiento', '');
INSERT INTO preventive_actions (tenant_id, id, project_id, alert_id, title, responsible, due_date,
  description, status, progress, created_at, updated_at) VALUES
  ${plan('PARITY-PREV-TSAPI', 'En ejecución')},
  ${plan('PARITY-PREV-GOAPI', 'En ejecución')},
  ${plan('PARITY-PREV-TSAPI-DONE', 'En ejecución')},
  ${plan('PARITY-PREV-GOAPI-DONE', 'En ejecución')},
  ${plan('PARITY-PREV-STOP', 'En ejecución')},
  ${plan('PARITY-PREV-GONE', 'Cancelada')};
INSERT INTO module_records (tenant_id, module, id, payload, created_at, updated_at, marking) VALUES
  ('${DEFAULT}', 'Alertas', 'PARITY-PREV-REC', '{}', '2026-01-02 00:00:00+00', '2026-01-02 00:00:00+00',
   'interno');
INSERT INTO attachments (tenant_id, id, storage_key, original_name, content_type, size_bytes, sha256,
  linked_module, record_module, linked_record_id, document_type, author, verification, notes,
  project_id, project_name, created_at) VALUES
  ('${DEFAULT}', 'PARITY-PREV-EV', 'parity/prev', 'acta.pdf', 'application/pdf', 1, repeat('b', 64),
   'alertas', 'Alertas', 'PARITY-PREV-REC', 'Acta', 'Equipo', 'E - No verificada', '', 'PRJ-SECHURA',
   'Sechura', '2026-01-02 00:00:00+00');
INSERT INTO digital_alert_reviews (tenant_id, id, project_id, created_at, source_url, source_type,
  excerpt, sha256, level, score, method, themes, signals, suggestions, semantic_active, status,
  analyst_note) VALUES
  ('PARITY/OTRO', 'AJENA-ALERT', 'PRJ-SECHURA', '2026-01-02 00:00:00+00', '', 'Documento', 'Fila AJENA',
   repeat('a', 64), 'Baja', 1, 'rules', '[]', '[]', '[]', false, 'En seguimiento', '');
INSERT INTO preventive_actions (tenant_id, id, project_id, alert_id, title, responsible, due_date,
  description, status, progress, created_at, updated_at, blocked_by, blocked_reason, blocked_since) VALUES
  ('PARITY/OTRO', 'AJENA-PLAN', 'PRJ-SECHURA', 'AJENA-ALERT', 'Plan AJENA', 'AJENA', '2020-01-01', '',
   'En ejecución', 50, '2026-01-02 00:00:00+00', '2026-01-02 00:00:00+00', 'Otro', 'AJENA',
   '2026-01-02 00:00:00+00');
INSERT INTO preventive_action_log (tenant_id, id, action_id, created_at, status, progress, note) VALUES
  ('PARITY/OTRO', 'AJENA-LOG', 'AJENA-PLAN', '2026-01-02 00:00:00+00', 'Pendiente', 0, 'Fila AJENA');
`;

const PLANS = '/system/prevention/actions';
const newPlan = {
  alert_id: 'PARITY-PREV-W',
  title: 'Plan de paridad',
  responsible: 'Equipo',
  due_date: '2099-02-28',
};
const created = {
  normalize: [
    'action.id',
    'action.created_at',
    'action.updated_at',
    'action.history.*.id',
    'action.history.*.action_id',
    'action.history.*.created_at',
  ],
};
const updated = {
  perApi: true,
  normalize: [
    'action.updated_at',
    'action.history.*.id',
    'action.history.*.created_at',
    'action.blocked.since',
  ],
} as const;
const write = { auth: 'admin', sameOrigin: true } as const;
const create = (name: string, json: unknown): ParityCase => ({
  name: `prevention create: ${name}`,
  method: 'POST',
  path: PLANS,
  ...write,
  body: { json },
});
const update = (name: string, id: string, json: unknown): ParityCase => ({
  name: `prevention update: ${name}`,
  method: 'PATCH',
  path: `${PLANS}/${id}`,
  ...write,
  body: { json },
});
const noSession = ({ auth: _auth, ...rest }: ParityCase): ParityCase => rest;
const noOrigin = ({ sameOrigin: _origin, ...rest }: ParityCase): ParityCase => rest;
const STOP = 'PARITY-PREV-STOP';
const running = { status: 'En ejecución', progress: 20 };

const writeCases: readonly ParityCase[] = [
  { ...create('success', newPlan), ...created },
  {
    ...create('with its project and a description', {
      ...newPlan,
      project_id: 'PRJ-SECHURA',
      description: 'Detalle',
    }),
    ...created,
  },
  {
    name: 'prevention create: a lone surrogate reaches the row as U+FFFD',
    method: 'POST',
    path: PLANS,
    ...write,
    ...created,
    body: {
      raw: '{"alert_id":"PARITY-PREV-W","title":"ab\\ud800cd","responsible":"Equipo","due_date":"2099-02-28"}',
    },
  },
  create('unverified alert', { ...newPlan, alert_id: 'PARITY-PREV-NEW' }),
  create('alert of another project in the tenant', { ...newPlan, alert_id: 'PARITY-PREV-X' }),
  create('alert of another tenant', { ...newPlan, alert_id: 'AJENA-ALERT' }),
  create('no such alert', { ...newPlan, alert_id: 'PARITY-PREV-NADA' }),
  create('empty object', {}),
  create('wrong types', { alert_id: 1, title: 2, responsible: 3, due_date: 4, description: 5 }),
  create('short and long strings', {
    ...newPlan,
    title: 'abcd',
    responsible: 'x'.repeat(151),
    description: 'x'.repeat(2001),
  }),
  create('impossible date', { ...newPlan, due_date: '2027-02-29' }),
  create('an array', []),
  create('NUL in the alert id', { ...newPlan, alert_id: 'a\0b' }),
  create('NUL in the title', { ...newPlan, title: 'ab\0cd' }),
  {
    name: 'prevention create: body that is not JSON',
    method: 'POST',
    path: PLANS,
    ...write,
    body: { raw: '{' },
  },
  {
    name: 'prevention create: a form body',
    method: 'POST',
    path: PLANS,
    ...write,
    body: { form: { alert_id: 'PARITY-PREV-W' } },
  },
  create('a body naming another project', { ...newPlan, project_id: 'PRJ-B' }),
  noSession(create('no session', newPlan)),
  noOrigin(create('no Origin', newPlan)),
  {
    ...create('the analyst of the second project', newPlan),
    auth: 'multi',
    headers: { 'x-sipges-scope': 'PARITY/PRJ-B' },
  },
  { ...create('an ungranted project', newPlan), headers: { 'x-sipges-scope': 'PARITY/OTRO' } },
  { ...create('the read-only role', newPlan), auth: 'consulta' },

  { ...update('progress', 'PARITY-PREV-{api}', running), ...updated },
  {
    ...update('blocked by a party', 'PARITY-PREV-{api}', {
      ...running,
      blocked_by: ' Comunidad ',
      blocked_reason: ' Asamblea ',
    }),
    ...updated,
  },
  {
    ...update('the same party', 'PARITY-PREV-{api}', {
      ...running,
      blocked_by: 'Comunidad',
      note: 'Sigue',
    }),
    ...updated,
  },
  {
    ...update('leaving the blocker as it was', 'PARITY-PREV-{api}', { ...running, progress: 30 }),
    ...updated,
  },
  {
    ...update('clearing the blocker', 'PARITY-PREV-{api}', { ...running, blocked_by: '' }),
    ...updated,
  },
  {
    ...update('completed with a receipt', 'PARITY-PREV-{api}-DONE', {
      status: 'Completada',
      progress: 100,
      note: 'Hecho',
      evidence_url: 'HTTPS://example.org/a',
      evidence_attachment_id: ' PARITY-PREV-EV ',
    }),
    ...updated,
  },
  update('unknown status', STOP, { status: 'Otro', progress: 0 }),
  update('completed under 100', STOP, { status: 'Completada', progress: 99 }),
  update('pending with progress', STOP, { status: 'Pendiente', progress: 1 }),
  update('bad evidence url', STOP, { ...running, evidence_url: 'ftp://example.org' }),
  update('without a receipt', STOP, { status: 'Completada', progress: 100, note: 'x' }),
  update('unknown receipt', STOP, { ...running, evidence_attachment_id: 'PARITY-PREV-NADA' }),
  update('NUL receipt', STOP, { ...running, evidence_attachment_id: 'a\0b' }),
  update('unknown blocker', STOP, { ...running, blocked_by: 'Nadie' }),
  update('closing without a note', STOP, { status: 'Cancelada', progress: 0, note: ' ' }),
  update('reactivating', 'PARITY-PREV-GONE', running),
  update('no such plan', 'PARITY-PREV-NADA', running),
  update('a plan of another tenant', 'AJENA-PLAN', running),
  update('an id over 80 units', '%F0%9F%98%80'.repeat(41), running),
  update('NUL in the id', 'a%00b', running),
  update('NUL in the note', STOP, { ...running, note: 'a\0b' }),
  update('empty object', STOP, {}),
  update('wrong types', STOP, { status: 1, progress: '2', note: 3, blocked_by: 4 }),
  update('fractional progress', STOP, { status: 'Pendiente', progress: 1.5 }),
  update('progress over 100', STOP, { ...running, progress: 101 }),
  update('long strings', STOP, {
    ...running,
    note: 'x'.repeat(2001),
    blocked_by: 'x'.repeat(41),
    blocked_reason: 'x'.repeat(501),
  }),
  noSession(update('no session', STOP, running)),
  {
    ...update('an ungranted project', STOP, running),
    headers: { 'x-sipges-scope': 'PARITY/OTRO' },
  },
  { ...update('the read-only role', STOP, running), auth: 'consulta' },
  { ...update('a trailing slash', `${STOP}/`, running) },
  { name: 'prevention plan with GET', method: 'GET', path: `${PLANS}/${STOP}`, auth: 'admin' },
  { name: 'prevention plan with DELETE', method: 'DELETE', path: `${PLANS}/${STOP}`, ...write },
  { name: 'prevention plans with PUT', method: 'PUT', path: PLANS, ...write, body: { json: {} } },
  { name: 'prevention plans after the writes', method: 'GET', path: PLANS, auth: 'admin' },
];

export const cases: readonly ParityCase[] = [
  ...(['actions', 'situation-room', 'summary'] as const).flatMap((route): ParityCase[] => {
    const path = `/system/prevention/${route}`;
    return [
      { name: `prevention ${route}`, method: 'GET', path, auth: 'admin' },
      { name: `prevention ${route} without a session`, method: 'GET', path },
      { name: `prevention ${route} read-only role`, method: 'GET', path, auth: 'consulta' },
      {
        name: `prevention ${route} of a project without a grant`,
        method: 'GET',
        path,
        auth: 'admin',
        headers: { 'x-sipges-scope': 'PARITY/PRJ-B' },
      },
      {
        name: `prevention ${route} of the ungranted fixture project`,
        method: 'GET',
        path,
        auth: 'multi',
        headers: { 'x-sipges-scope': 'PARITY/OTRO' },
      },
      {
        name: `prevention ${route} with project_id of another project`,
        method: 'GET',
        path: `${path}?project_id=PRJ-B`,
        auth: 'admin',
      },
      {
        name: `prevention ${route} with project_id of its project`,
        method: 'GET',
        path: `${path}?project_id=PRJ-SECHURA`,
        auth: 'admin',
      },
      { name: `prevention ${route} before choosing a project`, method: 'GET', path, auth: 'multi' },
      {
        name: `prevention ${route} of the second project`,
        method: 'GET',
        path,
        auth: 'multi',
        headers: { 'x-sipges-scope': 'PARITY/PRJ-B' },
      },
      {
        name: `prevention ${route} of the first project by a two-project user`,
        method: 'GET',
        path,
        auth: 'multi',
        headers: { 'x-sipges-scope': 'SIPGES/PRJ-SECHURA' },
      },
    ];
  }),
  {
    name: 'prevention actions with a trailing slash',
    method: 'GET',
    path: '/system/prevention/actions/',
    auth: 'admin',
  },
  {
    name: 'prevention plan write by the read-only role',
    method: 'POST',
    path: '/system/prevention/actions',
    auth: 'consulta',
    sameOrigin: true,
    body: { json: { alert_id: 'x', title: 'Plan', responsible: 'Equipo', due_date: '2099-01-01' } },
  },
  ...writeCases,
];
