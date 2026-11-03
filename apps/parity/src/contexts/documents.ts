import type { ParityCase } from '../types.ts';

/**
 * Documents, read-only (T29): GET /system/document-lab/review, the verification inbox. This seed
 * adds findings to the default project (approved with and without their record, a record marked
 * 'restringido' that `consulta` must not see linked, a pending item whose record id exists, a
 * discarded one under a numeric theme, two at the same instant, text with HTML characters,
 * U+2028 and an emoji), one to the second project, and, in OTHER_TENANT (see ../fixtures.ts),
 * findings and records reusing the default project's ids and project id, so only row-level
 * security keeps them out. Rows of OTHER_TENANT carry "AJENA" so a leak is plain in a mismatch
 * report. Ids start with PARITY-DOC and inserts skip existing rows, so no other seed matters.
 */
const SECHURA = 'SIPGES/PRJ-SECHURA';
const SECOND = 'PARITY/PRJ-B';
const OTHER = 'PARITY/OTRO';
const SHA = 'cd34'.repeat(16);

const quote = (text: string) => `'${text.replaceAll("'", "''")}'`;

const finding = (
  tenant: string,
  id: string,
  project: string,
  theme: string,
  status: string,
  createdAt: string,
  excerpt = `Extracto sintético ${id}`,
  { reviewer = '', note = '' } = {},
) =>
  `(${[tenant, id, project, 'acta-sintetica.pdf', SHA, 'página 2', theme, excerpt, `Revisar ${id}`, status, reviewer, note, createdAt, createdAt].map(quote).join(', ')})`;

const record = (tenant: string, module: string, id: string, marking = 'interno') =>
  `(${[tenant, module, id].map(quote).join(', ')}, jsonb_build_object('Asunto', ${quote(`Registro ${id}`)},
    'Proyecto_ID', 'PRJ-SECHURA', 'Revision_Documental_ID', ${quote(id.slice(4))}), ${quote(marking)},
    '2026-01-03T00:00:00Z', '2026-01-03T00:00:00Z')`;

export const seed = `
INSERT INTO document_review (tenant_id, id, project_id, source_file, source_sha256, location, theme,
  excerpt, action, status, reviewer, note, created_at, updated_at) VALUES
  ${[
    finding(
      SECHURA,
      'PARITY-DOC-1',
      'PRJ-SECHURA',
      'Controversias y hechos compartidos',
      'aceptado_para_revision',
      '2026-02-03 10:00:00.750+00',
      undefined,
      { reviewer: 'Equipo' },
    ),
    finding(
      SECHURA,
      'PARITY-DOC-0',
      'PRJ-SECHURA',
      'Controversias y hechos compartidos',
      'pendiente',
      '2026-02-03 10:00:00.750+00',
    ),
    finding(
      SECHURA,
      'PARITY-DOC-2',
      'PRJ-SECHURA',
      'Demandas e intereses',
      'corroborado_documentalmente',
      '2026-02-02 09:00:00+00',
      undefined,
      { reviewer: 'Equipo', note: 'Acta contrastada' },
    ),
    finding(
      SECHURA,
      'PARITY-DOC-3',
      'PRJ-SECHURA',
      'Hallazgo libre',
      'aceptado_para_revision',
      '2026-02-01 12:00:00+00',
      'Texto <b>&amp;</b>   con emoji 😀',
    ),
    finding(
      SECHURA,
      'PARITY-DOC-4',
      'PRJ-SECHURA',
      'Demandas e intereses',
      'pendiente',
      '2026-02-01 08:00:00+00',
    ),
    finding(
      SECHURA,
      'PARITY-DOC-5',
      'PRJ-SECHURA',
      '7',
      'descartado',
      '2026-01-31 00:00:00+00',
      undefined,
      { reviewer: 'Equipo', note: 'No aplica' },
    ),
    finding(
      SECOND,
      'PARITY-DOC-B1',
      'PRJ-B',
      'Territorio y ambiente',
      'aceptado_para_revision',
      '2026-02-04 00:00:00+00',
    ),
    finding(
      OTHER,
      'PARITY-DOC-1',
      'PRJ-SECHURA',
      'Hallazgo AJENA',
      'pendiente',
      '2026-02-05 00:00:00+00',
      'Fila AJENA',
    ),
    finding(
      OTHER,
      'PARITY-DOC-9',
      'PRJ-SECHURA',
      'Hallazgo AJENA',
      'aceptado_para_revision',
      '2026-02-06 00:00:00+00',
      'Fila AJENA',
    ),
  ].join(',\n  ')}
ON CONFLICT DO NOTHING;
INSERT INTO module_records (tenant_id, module, id, payload, marking, created_at, updated_at) VALUES
  ${[
    record(SECHURA, 'Hechos_Compartidos', 'REV-PARITY-DOC-1'),
    record(SECHURA, 'Demandas', 'REV-PARITY-DOC-2', 'restringido'),
    record(SECHURA, 'Demandas', 'REV-PARITY-DOC-4'),
    record(OTHER, 'Hechos_Compartidos', 'REV-PARITY-DOC-3'),
    record(OTHER, 'Hechos_Compartidos', 'REV-PARITY-DOC-9'),
  ].join(',\n  ')}
ON CONFLICT DO NOTHING;
`;

const PATH = '/system/document-lab/review';

const SCOPE_CASES: readonly ParityCase[] = [
  { name: 'documents review', method: 'GET', path: PATH, auth: 'admin' },
  { name: 'documents review without a session', method: 'GET', path: PATH },
  {
    name: 'documents review with an unknown session',
    method: 'GET',
    path: PATH,
    headers: { cookie: 'sipges_session=parity-unknown-session' },
  },
  { name: 'documents review read-only role', method: 'GET', path: PATH, auth: 'consulta' },
  {
    name: 'documents review of a project without a grant',
    method: 'GET',
    path: PATH,
    auth: 'admin',
    headers: { 'x-sipges-scope': SECOND },
  },
  {
    name: 'documents review of the ungranted fixture project',
    method: 'GET',
    path: PATH,
    auth: 'multi',
    headers: { 'x-sipges-scope': OTHER },
  },
  {
    name: 'documents review with project_id of another project',
    method: 'GET',
    path: `${PATH}?project_id=PRJ-B`,
    auth: 'admin',
  },
  {
    name: 'documents review with project_id of another project and an invalid limit',
    method: 'GET',
    path: `${PATH}?project_id=PRJ-B&limit=0`,
    auth: 'admin',
  },
  {
    name: 'documents review with project_id of its project',
    method: 'GET',
    path: `${PATH}?project_id=PRJ-SECHURA`,
    auth: 'admin',
  },
  { name: 'documents review before choosing a project', method: 'GET', path: PATH, auth: 'multi' },
  {
    name: 'documents review of the second project',
    method: 'GET',
    path: PATH,
    auth: 'multi',
    headers: { 'x-sipges-scope': SECOND },
  },
  {
    name: 'documents review of the first project by a two-project user',
    method: 'GET',
    path: PATH,
    auth: 'multi',
    headers: { 'x-sipges-scope': SECHURA },
  },
  {
    name: 'documents review with a trailing slash',
    method: 'GET',
    path: `${PATH}/`,
    auth: 'admin',
  },
  { name: 'documents review HEAD', method: 'HEAD', path: PATH, auth: 'admin' },
];

/** Filters and pages, each as the administrator of the default project. */
const QUERIES: readonly (readonly [string, string])[] = [
  ['pending only', '?status=pendiente'],
  ['one theme', '?theme=Demandas+e+intereses'],
  ['status and theme', '?status=aceptado_para_revision&theme=Hallazgo%20libre'],
  ['a numeric theme', '?theme=7'],
  ['an unknown status', '?status=nada'],
  ['empty filters', '?status=&theme='],
  ['a filter with NUL', '?theme=%00'],
  ['a status with NUL', '?status=a%00b'],
  ['a second page', '?limit=2&offset=1'],
  ['the largest page with leading zeros', '?limit=0200'],
  ['an offset past the end', '?offset=6'],
  ['the largest offset', '?offset=9007199254740991'],
  ['the first of two limits', '?limit=1&limit=abc'],
  ['an encoded parameter name', '?%6Cimit=1'],
  ['an undecodable filter', '?theme=%E0%A4%A'],
];

/** Every 422 of the page parameters; the limit is checked first. */
const INVALID: readonly (readonly [string, string])[] = [
  ['limit 0', '?limit=0'],
  ['limit over the page', '?limit=201'],
  ['an empty limit', '?limit='],
  ['a limit without a value', '?limit'],
  ['a fractional limit', '?limit=1.5'],
  ['a negative limit', '?limit=-1'],
  ['a signed limit', '?limit=%2B5'],
  ['a limit with spaces', '?limit=+5'],
  ['a non-ASCII digit limit', '?limit=%D9%A5'],
  ['both invalid', '?limit=0&offset=-1'],
  ['a negative offset', '?offset=-1'],
  ['a word offset', '?offset=abc'],
  ['an offset past the safe integers', '?offset=9007199254740992'],
  ['an exponent offset', '?offset=1e3'],
  ['an empty offset', '?limit=10&offset='],
  ['a huge offset', '?offset=99999999999999999999'],
];

export const cases: readonly ParityCase[] = [
  ...SCOPE_CASES,
  ...QUERIES.map(([label, query]): ParityCase => ({
    name: `documents review: ${label}`,
    method: 'GET',
    path: `${PATH}${query}`,
    auth: 'admin',
  })),
  {
    name: 'documents review: a filter as the read-only role',
    method: 'GET',
    path: `${PATH}?theme=Demandas+e+intereses`,
    auth: 'consulta',
  },
  ...INVALID.map(([label, query]): ParityCase => ({
    name: `documents review refuses ${label}`,
    method: 'GET',
    path: `${PATH}${query}`,
    auth: 'admin',
  })),
  {
    name: 'documents review decision by the read-only role',
    method: 'PATCH',
    path: `${PATH}/PARITY-DOC-4`,
    auth: 'consulta',
    sameOrigin: true,
    body: { json: { status: 'descartado' } },
  },
  {
    name: 'documents review bulk decision by the read-only role',
    method: 'POST',
    path: `${PATH}/bulk`,
    auth: 'consulta',
    sameOrigin: true,
    body: { json: { status: 'descartado', theme: 'Demandas e intereses' } },
  },
];
