import type { ParityCase } from '../types.ts';

/**
 * Synthetic evidence metadata for the evidence read routes (GET /system/uploads and
 * GET /system/uploads/:id) in the default project and OTHER_TENANT (see ../fixtures.ts). Only
 * metadata rows: no object is stored, so the preview and download routes (still TypeScript) are
 * not compared. Attachments hang from their own records (`PARITY-EVID-*`), so this seed never
 * depends on another context's rows; ON CONFLICT keeps it loadable in any order. One record is
 * marked 'restringido': its attachment is hidden from `consulta`. OTHER_TENANT reuses an
 * attachment id and carries "AJENA", so a leak is plain in a mismatch report.
 */

const SECHURA = 'SIPGES/PRJ-SECHURA';
const OTHER = 'PARITY/OTRO';
const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;

const record = (tenant: string, module: string, id: string, marking: string) =>
  `(${quote(tenant)}, ${quote(module)}, ${quote(id)}, '{}'::jsonb, ${quote(marking)},
    '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`;

type Attachment = {
  readonly tenant: string;
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly module: string;
  readonly record: string;
  readonly documentType: string;
  readonly author: string;
  readonly notes: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly createdAt: string;
  readonly size: number;
  readonly sha: string;
};

const attachment = (a: Attachment) =>
  `(${[a.tenant, a.id, `parity/${a.tenant}/${a.id}`, a.name, 'application/pdf']
    .map(quote)
    .join(', ')}, ${a.size}, ${[
    a.sha,
    a.slug,
    a.module,
    a.record,
    a.documentType,
    a.author,
    'E - No verificada',
    a.notes,
    a.projectId,
    a.projectName,
    a.createdAt,
  ]
    .map(quote)
    .join(', ')})`;

const base = {
  tenant: SECHURA,
  slug: 'fuentes',
  module: 'Fuentes',
  record: 'PARITY-EVID-F1',
  author: '',
  notes: '',
  projectId: 'PRJ-SECHURA',
  projectName: 'Proyecto Sechura',
  sha: SHA_A,
} as const;

const attachments: readonly Attachment[] = [
  {
    ...base,
    id: 'PARITY-ADJ-1',
    name: 'acta-de-reunion.pdf',
    documentType: 'Acta',
    author: 'Equipo social',
    notes: 'Firmada 100% al_fin <b>&</b>',
    createdAt: '2026-10-01T08:00:00.900Z',
    size: 1024,
  },
  {
    ...base,
    id: 'PARITY-ADJ-2',
    name: 'foto-campo.pdf',
    documentType: 'Reporte / evidencia',
    createdAt: '2026-10-02T09:00:00Z',
    size: 2048,
    sha: SHA_B,
  },
  // Same instant as PARITY-ADJ-2: ties are ordered by id, descending.
  {
    ...base,
    id: 'PARITY-ADJ-3',
    name: 'nota-de-prensa.pdf',
    slug: 'oportunidades',
    module: 'Oportunidades',
    record: 'PARITY-EVID-O1',
    documentType: 'Nota',
    author: 'Prensa ñandú',
    projectName: '',
    createdAt: '2026-10-02T09:00:00Z',
    size: 3,
  },
  // Its record is 'restringido': only full clearance sees the file.
  {
    ...base,
    id: 'PARITY-ADJ-R',
    name: 'reservado.pdf',
    slug: 'oportunidades',
    module: 'Oportunidades',
    record: 'PARITY-EVID-R1',
    documentType: 'Reservado',
    createdAt: '2026-10-03T00:00:00Z',
    size: 4,
  },
  // Another project: the same id and record, never in the default project's answers.
  {
    ...base,
    tenant: OTHER,
    id: 'PARITY-ADJ-1',
    name: 'ajena.pdf',
    documentType: 'Acta',
    author: 'AJENA',
    notes: 'AJENA',
    projectId: 'PRJ-SECHURA',
    projectName: 'AJENA',
    createdAt: '2026-10-04T00:00:00Z',
    size: 5,
  },
  {
    ...base,
    tenant: OTHER,
    id: 'PARITY-ADJ-AJENA',
    name: 'solo-ajena.pdf',
    documentType: 'Acta',
    author: 'AJENA',
    projectId: 'OTRO',
    projectName: 'AJENA',
    createdAt: '2026-10-04T00:00:00Z',
    size: 6,
  },
];

export const seed = `
INSERT INTO module_records (tenant_id, module, id, payload, marking, created_at, updated_at) VALUES
${[
  record(SECHURA, 'Fuentes', 'PARITY-EVID-F1', 'publico'),
  record(SECHURA, 'Oportunidades', 'PARITY-EVID-O1', 'interno'),
  record(SECHURA, 'Oportunidades', 'PARITY-EVID-R1', 'restringido'),
  record(OTHER, 'Fuentes', 'PARITY-EVID-F1', 'interno'),
].join(',\n')}
ON CONFLICT DO NOTHING;
INSERT INTO attachments (tenant_id, id, storage_key, original_name, content_type, size_bytes, sha256,
  linked_module, record_module, linked_record_id, document_type, author, verification, notes,
  project_id, project_name, created_at) VALUES
${attachments.map(attachment).join(',\n')}
ON CONFLICT DO NOTHING;
`;

const SECOND = { 'x-sipges-scope': 'PARITY/PRJ-B' };
const OTHER_SCOPE = { 'x-sipges-scope': OTHER };
const DEFAULT_SCOPE = { 'x-sipges-scope': SECHURA };

/** The cases every route gets: sessions, roles, project choice and project_id checks. */
const common = (route: string, path: string): ParityCase[] => {
  const withQuery = (query: string) => `${path}${path.includes('?') ? '&' : '?'}${query}`;
  return [
    { name: `${route}: active project`, method: 'GET', path, auth: 'admin' },
    { name: `${route}: read-only role`, method: 'GET', path, auth: 'consulta' },
    { name: `${route}: without a session`, method: 'GET', path },
    {
      name: `${route}: unknown session`,
      method: 'GET',
      path,
      headers: { cookie: `sipges_session=${'0'.repeat(64)}` },
    },
    { name: `${route}: two projects need a choice`, method: 'GET', path, auth: 'multi' },
    {
      name: `${route}: second project of a two-project user`,
      method: 'GET',
      path,
      auth: 'multi',
      headers: SECOND,
    },
    {
      name: `${route}: default project of a two-project user`,
      method: 'GET',
      path,
      auth: 'multi',
      headers: DEFAULT_SCOPE,
    },
    {
      name: `${route}: project without a grant`,
      method: 'GET',
      path,
      auth: 'admin',
      headers: OTHER_SCOPE,
    },
    {
      name: `${route}: query project_id of another project`,
      method: 'GET',
      path: withQuery('project_id=OTRO'),
      auth: 'admin',
    },
    {
      name: `${route}: query project_id of the active project`,
      method: 'GET',
      path: withQuery('project_id=PRJ-SECHURA'),
      auth: 'admin',
    },
    { name: `${route}: HEAD`, method: 'HEAD', path, auth: 'admin' },
  ];
};

const LIST = '/system/uploads';
const listCase = (name: string, query: string, auth: ParityCase['auth'] = 'admin'): ParityCase => ({
  name: `uploads list: ${name}`,
  method: 'GET',
  path: `${LIST}?${query}`,
  auth,
});

const detail = (id: string) => `${LIST}/${id}`;
const detailCase = (
  name: string,
  path: string,
  auth: ParityCase['auth'] = 'admin',
  extra: Partial<ParityCase> = {},
): ParityCase => ({ name: `upload detail: ${name}`, method: 'GET', path, auth, ...extra });

export const cases: readonly ParityCase[] = [
  ...common('uploads list', LIST),
  listCase('filter by module, trimmed and lower-cased', 'linked_module=%20FUENTES%20'),
  listCase(
    'filter by the restricted module as consulta',
    'linked_module=oportunidades',
    'consulta',
  ),
  listCase('filter by the restricted module as admin', 'linked_module=oportunidades'),
  listCase('filter by record', 'linked_record_id=PARITY-EVID-O1'),
  listCase('record id is not trimmed', 'linked_record_id=%20PARITY-EVID-O1'),
  listCase('empty filters are no filter', 'linked_module=&linked_record_id=&q='),
  listCase('search is case-insensitive', 'q=PRENSA'),
  listCase('search matches the document type', 'q=evidencia'),
  listCase('search % is literal', 'q=100%25'),
  listCase('search _ is literal', 'q=100_'),
  listCase('search _ matches itself', 'q=al_fin'),
  listCase('search with a backslash', 'q=%5C'),
  listCase('search never finds another project', 'q=AJENA'),
  listCase('NUL in the search', 'q=a%00b'),
  listCase('NUL in the module', 'linked_module=%00'),
  listCase('NUL in the record id', 'linked_record_id=%00'),
  listCase('limit', 'limit=2'),
  listCase('limit 0 reads one', 'limit=0'),
  listCase('negative limit reads one', 'limit=-9'),
  listCase('limit with spaces and plus', 'limit=%20+3%20'),
  listCase('huge limit', 'limit=99999999999999999999999'),
  listCase('limit 422: letters', 'limit=abc'),
  listCase('limit 422: decimal', 'limit=1.5'),
  listCase('limit 422: empty', 'limit='),
  listCase('limit 422: exponent', 'limit=1e3'),
  listCase('limit 422: fullwidth digit', 'limit=%EF%BC%91'),
  listCase('limit 422 before the scope check', 'limit=x&project_id=PRJ-SECHURA'),
  listCase('encoded parameter name', 'linked%5Fmodule=oportunidades'),
  listCase('repeated parameter: first wins', 'linked_module=fuentes&linked_module=oportunidades'),
  { name: 'uploads list: trailing slash', method: 'GET', path: `${LIST}/`, auth: 'admin' },

  ...common('upload detail', detail('PARITY-ADJ-1')),
  detailCase('restricted record as admin', detail('PARITY-ADJ-R')),
  detailCase('restricted record as consulta', detail('PARITY-ADJ-R'), 'consulta'),
  detailCase('id of another project', detail('PARITY-ADJ-AJENA')),
  detailCase('id of another project with its scope', detail('PARITY-ADJ-AJENA'), 'admin', {
    headers: OTHER_SCOPE,
  }),
  detailCase('missing id', detail('PARITY-ADJ-NONE')),
  detailCase('encoded id', detail('PARITY-ADJ-%31')),
  detailCase('id with an encoded slash', detail('a%2Fb')),
  detailCase('id with an encoded percent', detail('100%25')),
  detailCase('id with NUL', detail('a%00b')),
  detailCase('id of 64 characters', detail('A'.repeat(64))),
  detailCase('id of 65 characters', detail('A'.repeat(65))),
  detailCase('non-ASCII id', detail('%C3%B1')),
  detailCase('undecodable id', detail('bad%E0%A4')),
  detailCase('trailing slash', `${detail('PARITY-ADJ-1')}/`),
  // Uploads stay in TypeScript; the role gate refuses them for consulta in both APIs.
  {
    name: 'uploads: write refused for the read-only role',
    method: 'POST',
    path: LIST,
    auth: 'consulta',
    sameOrigin: true,
    body: { form: { linked_module: 'fuentes', linked_record_id: 'PARITY-EVID-F1' } },
  },
];
