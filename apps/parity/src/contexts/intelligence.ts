import type { ParityCase } from '../types.ts';

/**
 * Intelligence, read-only (T27): the territorial alert inbox (GET
 * /system/intelligence/territorial-alerts, /territorial-alerts/:id and /territorial-summary).
 * seed.ts already creates one verified alert per project through the TypeScript API; this seed
 * adds fixed-id alerts in DEFAULT_TENANT (one of them under another project id of the same
 * tenant) and in OTHER_TENANT (see ../fixtures.ts) with the default project's project id, so
 * only row-level security keeps the latter out. Themes exercise how JavaScript reads `t.tema`
 * (a missing `tema`, a number stored as 1.0, an object); OTHER_TENANT's rows carry "AJENA" so a
 * leak is plain in a mismatch report. Ids are prefixed PARITY-INT and inserts skip rows that
 * already exist, so the seed does not depend on any other context's seed.
 *
 * Writes (T40): POST /system/analyze, POST /system/intelligence/analyze-text and PATCH
 * /system/intelligence/territorial-alerts/:id. The runner sends each case to both APIs at the
 * same time on one database, so every write case is one whose answer does not depend on which
 * API writes first: decisions that end in the same state (repeats included), refusals that
 * write nothing, and the read that follows. The first of two validations of a high-priority
 * alert depends on that order and is covered by apps/api-go's integration test instead. The
 * PARITY-INT-W alerts belong to these cases only.
 */
const SECHURA = 'SIPGES/PRJ-SECHURA';
const OTHER = 'PARITY/OTRO';

const row = (
  tenant: string,
  project: string,
  id: string,
  createdAt: string,
  level: string,
  status: string,
  themes: string,
  optional = 'NULL, NULL, NULL, NULL, NULL',
) => `('${tenant}', '${id}', '${project}', '${createdAt}', 'https://example.org/${id}', 'Documento',
  'Texto sintético ${id} <b>&amp; 😀', repeat('c', 64), '${level}', 9, 'Reglas verificables',
  '${themes}', '[{"tipo":"actor","valor":"Comunidad"}]', '["Verificar en campo"]', false, '${status}',
  'Nota ${id}', ${optional})`;

export const seed = `
INSERT INTO digital_alert_reviews (tenant_id, id, project_id, created_at, source_url, source_type,
  excerpt, sha256, level, score, method, themes, signals, suggestions, semantic_active, status,
  analyst_note, reviewer_note, reviewed_at, territory, source_record, first_validator) VALUES
  ${row(
    SECHURA,
    'PRJ-SECHURA',
    'PARITY-INT-A',
    '2026-01-05 08:00:00.987+00',
    'Alta',
    'Corroborado',
    '[{"tema":"Agua"},{"tema":"Tierra"},{"x":1},{"tema":1.0},{"tema":{"a":1}}]',
    `'Revisado', '2026-01-06 09:30:00.5+00', 'Caserío sintético', '{"module":"Narrativas","id":"PARITY-NAR-1"}', 'parity-multi'`,
  )},
  ${row(SECHURA, 'PRJ-SECHURA', 'PARITY-INT-B', '2026-01-04 00:00:00+00', 'Media', 'Pendiente de verificación', '[{"tema":"Tierra"}]')},
  ${row(SECHURA, 'PRJ-SECHURA', 'PARITY-INT-C', '2026-01-04 00:00:00+00', 'Baja', 'Descartado', '[]')},
  ${row(SECHURA, 'PRJ-OTRO-INT', 'PARITY-INT-X', '2026-01-07 00:00:00+00', 'Alta', 'Corroborado', '[{"tema":"Proyecto AJENO"}]')},
  ${row(OTHER, 'PRJ-SECHURA', 'PARITY-INT-A', '2026-01-08 00:00:00+00', 'Alta', 'Corroborado', '[{"tema":"Tema AJENA"}]')},
  ${row(OTHER, 'PRJ-SECHURA', 'PARITY-INT-AJENA', '2026-01-08 00:00:00+00', 'Alta', 'En seguimiento', '[{"tema":"Tema AJENA"}]')},
  ${row(SECHURA, 'PRJ-SECHURA', 'PARITY-INT-W-MEDIA', '2026-01-02 00:00:00+00', 'Media', 'Pendiente de verificación', '[]')},
  ${row(SECHURA, 'PRJ-SECHURA', 'PARITY-INT-W-ALTA', '2026-01-02 00:00:00+00', 'Alta', 'Pendiente de verificación', '[]', `NULL, NULL, NULL, '{"module":"Narrativas","id":"PARITY-NAR-2"}', 'parity-colega'`)},
  ${row(SECHURA, 'PRJ-SECHURA', 'PARITY-INT-W-SAME', '2026-01-02 00:00:00+00', 'Alta', 'Pendiente de verificación', '[]', `NULL, NULL, NULL, NULL, 'parity-multi'`)},
  ${row(SECHURA, 'PRJ-SECHURA', 'PARITY-INT-W-KEEP', '2026-01-02 00:00:00+00', 'Media', 'Pendiente de verificación', '[]')},
  ${row(SECHURA, 'PRJ-OTRO-INT', 'PARITY-INT-W-OTRO', '2026-01-02 00:00:00+00', 'Media', 'Pendiente de verificación', '[]')},
  ${row(OTHER, 'PRJ-SECHURA', 'PARITY-INT-W-AJENA', '2026-01-02 00:00:00+00', 'Media', 'Pendiente de verificación', '[]')}
ON CONFLICT DO NOTHING;
-- A narrative only the ungranted tenant holds: the text analysis must never read it.
INSERT INTO module_records (tenant_id, module, id, payload, created_at, updated_at) VALUES
  ('${OTHER}', 'Narrativas', 'PARITY-INT-NAR-AJENA',
   '{"Tema":"Tema AJENA","Descripcion":"Asamblea AJENA por el agua y el paro","Proyecto_ID":"PRJ-SECHURA"}',
   '2026-01-09 00:00:00+00', '2026-01-09 00:00:00+00')
ON CONFLICT DO NOTHING;
`;

const LIST = '/system/intelligence/territorial-alerts';
const ONE = `${LIST}/PARITY-INT-A`;
const SUMMARY = '/system/intelligence/territorial-summary';

/** The cases every read route gets: sessions, roles, project choice and scope refusals. */
const scoped = (label: string, path: string): ParityCase[] => {
  const withQuery = (query: string) => `${path}${path.includes('?') ? '&' : '?'}${query}`;
  return [
    { name: `intelligence ${label}`, method: 'GET', path, auth: 'admin' },
    { name: `intelligence ${label} without a session`, method: 'GET', path },
    {
      name: `intelligence ${label} with an unknown session`,
      method: 'GET',
      path,
      headers: { cookie: `sipges_session=${'0'.repeat(64)}` },
    },
    { name: `intelligence ${label} read-only role`, method: 'GET', path, auth: 'consulta' },
    {
      name: `intelligence ${label} of a project without a grant`,
      method: 'GET',
      path,
      auth: 'admin',
      headers: { 'x-sipges-scope': 'PARITY/PRJ-B' },
    },
    {
      name: `intelligence ${label} of the ungranted fixture project`,
      method: 'GET',
      path,
      auth: 'multi',
      headers: { 'x-sipges-scope': 'PARITY/OTRO' },
    },
    {
      name: `intelligence ${label} with project_id of another project`,
      method: 'GET',
      path: withQuery('project_id=PRJ-B'),
      auth: 'admin',
    },
    {
      name: `intelligence ${label} with project_id of its project`,
      method: 'GET',
      path: withQuery('project_id=PRJ-SECHURA'),
      auth: 'admin',
    },
    { name: `intelligence ${label} before choosing a project`, method: 'GET', path, auth: 'multi' },
    {
      name: `intelligence ${label} of the second project`,
      method: 'GET',
      path,
      auth: 'multi',
      headers: { 'x-sipges-scope': 'PARITY/PRJ-B' },
    },
    {
      name: `intelligence ${label} of the first project by a two-project user`,
      method: 'GET',
      path,
      auth: 'multi',
      headers: { 'x-sipges-scope': 'SIPGES/PRJ-SECHURA' },
    },
    { name: `intelligence ${label} HEAD`, method: 'HEAD', path, auth: 'admin' },
    {
      name: `intelligence ${label} with a trailing slash`,
      method: 'GET',
      path: `${path}/`,
      auth: 'admin',
    },
  ];
};

const get = (name: string, path: string): ParityCase => ({
  name: `intelligence ${name}`,
  method: 'GET',
  path,
  auth: 'admin',
});

const ANALYZE = '/system/analyze';
const TEXT = '/system/intelligence/analyze-text';
const W = `${LIST}/PARITY-INT-W`;

/** How a write case departs from a same-origin write of the administrator. */
type WriteOptions = {
  /** null sends no session. */
  readonly auth?: ParityCase['auth'] | null;
  /** false sends no same-origin Origin header. */
  readonly sameOrigin?: false;
  readonly headers?: Readonly<Record<string, string>>;
};

const write = (
  name: string,
  method: 'POST' | 'PATCH',
  path: string,
  json: unknown,
  { auth = 'admin', sameOrigin, headers }: WriteOptions = {},
): ParityCase => ({
  name: `intelligence ${name}`,
  method,
  path,
  body: { json },
  ...(auth === null ? {} : { auth }),
  ...(sameOrigin === false ? {} : { sameOrigin: true }),
  ...(headers ? { headers } : {}),
});

const raw = (name: string, method: 'POST' | 'PATCH', path: string, body: string): ParityCase => ({
  name: `intelligence ${name}`,
  method,
  path,
  auth: 'admin',
  sameOrigin: true,
  body: { raw: body },
});

/** Session, Origin, role and project refusals of one write route: none of them writes. */
const refusals = (label: string, method: 'POST' | 'PATCH', path: string, json: unknown) => [
  write(`${label} without a session`, method, path, json, { auth: null }),
  write(`${label} with an unknown session`, method, path, json, {
    auth: null,
    headers: { cookie: `sipges_session=${'0'.repeat(64)}` },
  }),
  write(`${label} without Origin`, method, path, json, { sameOrigin: false }),
  write(`${label} from another origin`, method, path, json, {
    sameOrigin: false,
    headers: { origin: 'https://otro.example' },
  }),
  write(`${label} by the read-only role`, method, path, json, { auth: 'consulta' }),
  write(`${label} before choosing a project`, method, path, json, { auth: 'multi' }),
  write(`${label} in a project without a grant`, method, path, json, {
    headers: { 'x-sipges-scope': 'PARITY/PRJ-B' },
  }),
  write(`${label} in the ungranted fixture project`, method, path, json, {
    auth: 'multi',
    headers: { 'x-sipges-scope': 'PARITY/OTRO' },
  }),
  write(`${label} naming another project in the body`, method, path, {
    ...(json as object),
    project_id: 'PRJ-B',
  }),
  write(`${label} naming another project in the query`, method, `${path}?project_id=PRJ-B`, json),
  write(`${label} with a trailing slash`, method, `${path}/`, json),
];

const verify = { status: 'Corroborado', reviewer_note: 'Corroborado en campo (sintético)' };
const discard = { status: 'Descartado', reviewer_note: 'Sin sustento <b>&amp; 😀' };

const writeCases: ParityCase[] = [
  // POST /system/analyze: the classifier engine; computes and stores nothing.
  write('classify a record', 'POST', ANALYZE, {
    payload: {
      Titulo: 'Reunión con la Junta Transitoria',
      Detalle: 'El administrador judicial expuso sus facultades y la representación legal.',
    },
  }),
  write('classify digital narratives', 'POST', ANALYZE, {
    payload: { Resumen: 'Publicaciones en Facebook con tono negativo; información no verificada.' },
  }),
  write('classify an empty record', 'POST', ANALYZE, { payload: {} }),
  write('classify a record with numeric keys', 'POST', ANALYZE, {
    payload: {
      '2': 'paro',
      b: 'bloqueo de vía',
      '1': 'agua del pozo',
      Nivel: 3,
      Lista: ['marcha'],
    },
  }),
  write('classify a record of its own project', 'POST', ANALYZE, {
    project_id: 'PRJ-SECHURA',
    payload: { Proyecto_ID: 'PRJ-SECHURA', Texto: 'Asamblea comunal' },
  }),
  write(
    'classify by the read-only role',
    'POST',
    ANALYZE,
    { payload: { Texto: 'Mapa de actores' } },
    {
      auth: 'consulta',
    },
  ),
  write('classify the same record twice (1)', 'POST', ANALYZE, {
    payload: { Texto: 'Disputa por la mina' },
  }),
  write('classify the same record twice (2)', 'POST', ANALYZE, {
    payload: { Texto: 'Disputa por la mina' },
  }),
  write('classify without payload', 'POST', ANALYZE, {}),
  write('classify a list payload', 'POST', ANALYZE, { payload: [] }),
  write('classify a null payload', 'POST', ANALYZE, { payload: null }),
  write('classify a text payload', 'POST', ANALYZE, { payload: 'paro' }),
  write('classify a numeric payload', 'POST', ANALYZE, { payload: 1.5 }),
  write('classify a list body', 'POST', ANALYZE, [{ payload: {} }]),
  write('classify a null body', 'POST', ANALYZE, null),
  write('classify naming another project in the payload', 'POST', ANALYZE, {
    payload: { Proyecto_ID: 'PRJ-B' },
  }),
  raw('classify invalid JSON', 'POST', ANALYZE, '{"payload":'),
  raw('classify an empty body', 'POST', ANALYZE, ''),
  raw('classify trailing data', 'POST', ANALYZE, '{"payload":{}} {}'),
  raw('classify duplicate keys', 'POST', ANALYZE, '{"payload":{},"payload":[]}'),
  raw('classify with a byte order mark', 'POST', ANALYZE, '﻿{"payload":{"Texto":"paro"}}'),
  ...refusals('classify', 'POST', ANALYZE, { payload: { Texto: 'paro' } }).filter(
    // The read-only role may classify (a read-only POST), shown above.
    (c) => c.auth !== 'consulta',
  ),

  // POST /system/intelligence/analyze-text: the text engine over the scope's narratives.
  write('analyze a text', 'POST', TEXT, {
    text: 'Exigimos agua limpia: se rumorea que habrá PARO y bloqueo este lunes. Convocatoria a asamblea.',
    source_url: 'https://example.org/p',
  }),
  write('analyze a text without source', 'POST', TEXT, {
    text: '  La dirigente pidió una reunión de diálogo sobre empleo, salario y contratación local.  ',
  }),
  write('analyze a text of its own project', 'POST', TEXT, {
    text: 'Asamblea por el agua',
    project_id: 'PRJ-SECHURA',
  }),
  write(
    'analyze a text in the second project',
    'POST',
    TEXT,
    { text: 'Asamblea por el agua y el paro' },
    {
      auth: 'multi',
      headers: { 'x-sipges-scope': 'PARITY/PRJ-B' },
    },
  ),
  write(
    'analyze a text in the first project by a two-project user',
    'POST',
    TEXT,
    {
      text: 'Asamblea por el agua y el paro',
    },
    { auth: 'multi', headers: { 'x-sipges-scope': 'SIPGES/PRJ-SECHURA' } },
  ),
  write('analyze a blank text', 'POST', TEXT, { text: ' \n\t ' }),
  write('analyze a text that is too long', 'POST', TEXT, { text: 'a'.repeat(20_001) }),
  write('analyze a text of 20000 emoji', 'POST', TEXT, { text: '😀'.repeat(20_000) }),
  write('analyze without text', 'POST', TEXT, {}),
  write('analyze with wrong types', 'POST', TEXT, { text: null, source_url: 2, project_id: 0 }),
  write('analyze with a null project_id', 'POST', TEXT, { text: [], project_id: null }),
  write('analyze with a false project_id', 'POST', TEXT, { text: 'a', project_id: false }),
  write('analyze a list body', 'POST', TEXT, ['texto']),
  raw('analyze invalid JSON', 'POST', TEXT, 'texto'),
  ...refusals('analyze a text', 'POST', TEXT, { text: 'Asamblea por el agua' }),

  // PATCH an alert: decisions whose final state does not depend on which API applies first.
  write('decide a medium alert', 'PATCH', `${W}-MEDIA`, discard),
  get('alert after its decision', `${W}-MEDIA`),
  write('decide a medium alert again', 'PATCH', `${W}-MEDIA`, discard),
  write(
    'decide a medium alert by an encoded id',
    'PATCH',
    `${LIST}/PARITY%2DINT%2DW-MEDIA`,
    discard,
  ),
  get('alert after the repeated decision', `${W}-MEDIA`),
  // Already validated once by another person: this decision is the second validation.
  write('confirm a high-priority alert', 'PATCH', `${W}-ALTA`, verify),
  get('alert after its confirmation', `${W}-ALTA`),
  write('confirm a high-priority alert again', 'PATCH', `${W}-ALTA`, verify),
  write('follow a confirmed alert', 'PATCH', `${W}-ALTA`, { status: 'En seguimiento' }),
  get('alert after a status change without a note', `${W}-ALTA`),
  // The first validator may not confirm alone; nothing is written.
  write('confirm by the first validator', 'PATCH', `${W}-SAME`, verify, {
    auth: 'multi',
    headers: { 'x-sipges-scope': 'SIPGES/PRJ-SECHURA' },
  }),
  get('alert after a refused confirmation', `${W}-SAME`),
  write('decide an alert of another project of the tenant', 'PATCH', `${W}-OTRO`, discard),
  write('decide an alert only another tenant holds', 'PATCH', `${W}-AJENA`, discard),
  write('decide an alert from the second project', 'PATCH', `${W}-KEEP`, discard, {
    auth: 'multi',
    headers: { 'x-sipges-scope': 'PARITY/PRJ-B' },
  }),
  write('decide an alert that does not exist', 'PATCH', `${LIST}/PARITY-INT-W-NONE`, discard),
  write('decide an id of 64 characters', 'PATCH', `${LIST}/${'A'.repeat(64)}`, discard),
  write('decide an id longer than 64 characters', 'PATCH', `${LIST}/${'A'.repeat(65)}`, discard),
  write('decide with an unknown status', 'PATCH', `${W}-KEEP`, { status: 'Cerrado' }),
  write('decide with a note that is too long', 'PATCH', `${W}-KEEP`, {
    status: 'Descartado',
    reviewer_note: 'ñ'.repeat(2001),
  }),
  write(
    'decide with a note of 2000 emoji on a missing alert',
    'PATCH',
    `${LIST}/PARITY-INT-W-NONE`,
    {
      status: 'Descartado',
      reviewer_note: '😀'.repeat(2000),
    },
  ),
  write('decide without status', 'PATCH', `${W}-KEEP`, {}),
  write('decide with wrong types', 'PATCH', `${W}-KEEP`, { status: 1, reviewer_note: 3 }),
  write('decide with a null note', 'PATCH', `${W}-KEEP`, { status: 'x', reviewer_note: null }),
  write('decide with a list body', 'PATCH', `${W}-KEEP`, [discard]),
  raw('decide with invalid JSON', 'PATCH', `${W}-KEEP`, '{"status":'),
  ...refusals('decide an alert', 'PATCH', `${W}-KEEP`, discard),
  get('alert after every refused decision', `${W}-KEEP`),
  get('alerts after the decisions', LIST),
  get('summary after the decisions', SUMMARY),
];

export const cases: readonly ParityCase[] = [
  ...scoped('alerts', LIST),
  ...scoped('alert', ONE),
  ...scoped('summary', SUMMARY),
  ...scoped('alerts with a limit', `${LIST}?limit=2`),

  // limit: parseIntQuery, then clamped to 1..200.
  get('alerts limit 1', `${LIST}?limit=1`),
  get('alerts limit 0 reads one', `${LIST}?limit=0`),
  get('alerts negative limit reads one', `${LIST}?limit=-7`),
  get('alerts limit with spaces and a sign', `${LIST}?limit=%20%2B3%20`),
  get('alerts limit above the maximum', `${LIST}?limit=99999999999999999999`),
  get('alerts empty limit', `${LIST}?limit=`),
  get('alerts limit without a value', `${LIST}?limit`),
  get('alerts decimal limit', `${LIST}?limit=1.5`),
  get('alerts exponent limit', `${LIST}?limit=1e2`),
  get('alerts word limit', `${LIST}?limit=dos`),
  get('alerts full-width digit limit', `${LIST}?limit=%EF%BC%91`),
  get('alerts second limit ignored', `${LIST}?limit=1&limit=x`),

  // One alert: only the scope's project, only its tenant, ids decoded like Hono's params.
  get('alert of another project of the tenant', `${LIST}/PARITY-INT-X`),
  get('alert only another tenant holds', `${LIST}/PARITY-INT-AJENA`),
  get('alert that does not exist', `${LIST}/PARITY-INT-NONE`),
  get('alert with an encoded id', `${LIST}/PARITY%2DINT%2DB`),
  get('alert with an encoded slash', `${LIST}/PARITY-INT%2FB`),
  // A malformed escape (%E0%A4%A) is not compared: Go's server refuses it with 400 before
  // routing, a known fail-closed limit (apps/api-go/README.md, Authentication and project scope).
  get('alert id of 80 characters', `${LIST}/${'A'.repeat(80)}`),
  get('alert id longer than 80 characters', `${LIST}/${'A'.repeat(81)}`),
  get('alert id of 41 emoji', `${LIST}/${encodeURIComponent('😀'.repeat(41))}`),
  get('alert with a nested path', `${LIST}/PARITY-INT-A/extra`),
  {
    name: 'intelligence alert in the read-only role',
    method: 'GET',
    path: `${LIST}/PARITY-INT-B`,
    auth: 'consulta',
  },

  // Alert creation stays in TypeScript (embeddings); the role gate answers the same in both.
  {
    name: 'intelligence alert creation by the read-only role',
    method: 'POST',
    path: LIST,
    auth: 'consulta',
    sameOrigin: true,
    body: { json: { text: 'Texto sintético', mode: 'rules' } },
  },
  ...writeCases,
];
