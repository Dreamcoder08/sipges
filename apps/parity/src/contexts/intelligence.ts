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
  ${row(OTHER, 'PRJ-SECHURA', 'PARITY-INT-AJENA', '2026-01-08 00:00:00+00', 'Alta', 'En seguimiento', '[{"tema":"Tema AJENA"}]')}
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

  // Writes stay in TypeScript; the role gate still answers the same in both APIs.
  {
    name: 'intelligence alert decision by the read-only role',
    method: 'PATCH',
    path: ONE,
    auth: 'consulta',
    sameOrigin: true,
    body: { json: { status: 'Descartado' } },
  },
  {
    name: 'intelligence alert creation by the read-only role',
    method: 'POST',
    path: LIST,
    auth: 'consulta',
    sameOrigin: true,
    body: { json: { text: 'Texto sintético', mode: 'rules' } },
  },
];
