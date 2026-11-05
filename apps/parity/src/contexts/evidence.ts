import type { ParityCase } from '../types.ts';

/**
 * Synthetic evidence for every evidence route in the default project and OTHER_TENANT (see
 * ../fixtures.ts). The seed holds metadata rows only: each API keeps objects in its own local
 * directory (SIPGES_UPLOAD_DIR defaults to .data/uploads under each one's working directory),
 * so downloads and previews compare the answers that need no stored bytes (404, 410 for an
 * object that is gone, images and download-only formats, gates) and uploads compare their JSON
 * with the random id and the clock normalized. File bytes and headers are pinned by the Go
 * integration tests (apps/api-go/internal/evidence/http). Attachments hang from their own
 * records (`PARITY-EVID-*`), so this seed never depends on another context's rows; ON CONFLICT
 * keeps it loadable in any order. One record is marked 'restringido': its attachments are
 * hidden from `consulta`. OTHER_TENANT reuses an attachment id and carries "AJENA", so a leak
 * is plain in a mismatch report.
 */

const SECHURA = 'SIPGES/PRJ-SECHURA';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const OTHER = 'PARITY/OTRO';
const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;

const record = (tenant: string, module: string, id: string, marking: string) =>
  `(${quote(tenant)}, ${quote(module)}, ${quote(id)}, '{}'::jsonb, ${quote(marking)},
    '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`;

type Attachment = {
  readonly tenant: string;
  /** Object key; by default one in no adapter's layout (`parity/...`). */
  readonly key?: string;
  readonly contentType?: string;
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
  `(${[
    a.tenant,
    a.id,
    a.key ?? `parity/${a.tenant}/${a.id}`,
    a.name,
    a.contentType ?? 'application/pdf',
  ]
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
  // Keys in the adapters' layout whose objects were never stored: the file is gone (410), except
  // for images and download-only formats, which the viewer answers without reading bytes.
  ...(
    [
      ['PARITY-ADJ-TXT', 'nota.txt', 'text/plain', 'PARITY-EVID-F1', 'fuentes', 'Fuentes'],
      ['PARITY-ADJ-PDF', 'informe.pdf', 'application/pdf', 'PARITY-EVID-F1', 'fuentes', 'Fuentes'],
      ['PARITY-ADJ-IMG', 'foto.png', 'image/png', 'PARITY-EVID-F1', 'fuentes', 'Fuentes'],
      ['PARITY-ADJ-XLS', 'tabla.xlsx', XLSX, 'PARITY-EVID-F1', 'fuentes', 'Fuentes'],
      [
        'PARITY-ADJ-RT',
        'reservado.txt',
        'text/plain',
        'PARITY-EVID-R1',
        'oportunidades',
        'Oportunidades',
      ],
    ] as const
  ).map(([id, name, contentType, record, slug, module], i): Attachment => ({
    ...base,
    id,
    name,
    contentType,
    record,
    slug,
    module,
    key: `${'0'.repeat(23)}${i}/${'f'.repeat(32)}_${name}`,
    documentType: 'Objeto ausente',
    createdAt: '2026-09-01T00:00:00Z',
    size: 7,
  })),
];

export const seed = `
INSERT INTO module_records (tenant_id, module, id, payload, marking, created_at, updated_at) VALUES
${[
  record(SECHURA, 'Fuentes', 'PARITY-EVID-F1', 'publico'),
  record(SECHURA, 'Oportunidades', 'PARITY-EVID-O1', 'interno'),
  record(SECHURA, 'Oportunidades', 'PARITY-EVID-R1', 'restringido'),
  record(OTHER, 'Fuentes', 'PARITY-EVID-F1', 'interno'),
  // Upload targets: one per module the uploads write back into, and one only OTHER_TENANT has.
  record(SECHURA, 'Eventos', 'PARITY-EVID-U1', 'interno'),
  record(SECHURA, 'Fuentes', 'PARITY-EVID-U2', 'publico'),
  record(OTHER, 'Eventos', 'PARITY-EVID-OTRO', 'interno'),
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

const BOUNDARY = 'parityBoundary0123456789abcdefXYZ';
const MULTIPART = `multipart/form-data; boundary=${BOUNDARY}`;
type Part = readonly [disposition: string, body: string];
const field = (name: string, value: string): Part => [`form-data; name="${name}"`, value];
const file = (fileName: string, body: string): Part => [
  `form-data; name="file"; filename="${fileName}"`,
  body,
];
const multipart = (...parts: Part[]) =>
  `${parts.map(([d, b]) => `--${BOUNDARY}\r\nContent-Disposition: ${d}\r\n\r\n${b}\r\n`).join('')}--${BOUNDARY}--\r\n`;
const TO_U1 = [field('linked_module', 'eventos'), field('linked_record_id', 'PARITY-EVID-U1')];
/** Each upload creates its own attachment in both APIs: only the random id and the clock differ. */
const RANDOM = ['attachment.id', 'attachment.download_url', 'attachment.created_at'];

const upload = (
  name: string,
  body: string,
  extra: Partial<ParityCase> = {},
  contentType = MULTIPART,
  drop: readonly ('auth' | 'sameOrigin')[] = [],
): ParityCase => {
  const c: ParityCase = {
    name: `upload: ${name}`,
    method: 'POST',
    path: LIST,
    auth: 'admin',
    sameOrigin: true,
    headers: { 'content-type': contentType },
    body: { raw: body },
    normalize: RANDOM,
    ...extra,
  };
  const { auth, sameOrigin, ...rest } = c;
  return {
    ...rest,
    ...(drop.includes('auth') || !auth ? {} : { auth }),
    ...(drop.includes('sameOrigin') || !sameOrigin ? {} : { sameOrigin }),
  };
};

const uploads: readonly ParityCase[] = [
  upload(
    'a text file to an event',
    multipart(file('Nota de campo ñ.TXT', 'hola\nmundo'), ...TO_U1),
  ),
  upload(
    'a CSV to a source with every metadata field',
    multipart(
      file('tabla.csv', 'a,b\n1,2\n'),
      field('linked_module', ' FUENTES '),
      field('linked_record_id', 'PARITY-EVID-U2'),
      field('document_type', 'Acta <b>&</b>'),
      field('author', 'Equipo 😀'),
      field('verification', `${'v'.repeat(78)}😀`),
      field('notes', 'n'.repeat(1001)),
    ),
  ),
  upload(
    'empty metadata stays empty',
    multipart(file('a.txt', 'x'), ...TO_U1, field('document_type', ''), field('verification', '')),
  ),
  upload(
    'a PDF to a restricted record as admin',
    multipart(
      file('reservado.pdf', '%PDF-1.7 x'),
      field('linked_module', 'oportunidades'),
      field('linked_record_id', 'PARITY-EVID-R1'),
    ),
  ),
  upload('path traversal in the name', multipart(file('../../etc/passwd%00.txt', 'x'), ...TO_U1)),
  upload(
    'CR LF and quotes in the name',
    multipart(file('a%0D%0AX-Injected: 1%22.txt', 'x'), ...TO_U1),
  ),
  upload(
    'a Windows path in the name',
    multipart(file('C:\\Users\\x\\Escritorio\\informe final.txt', 'x'), ...TO_U1),
  ),
  upload('an empty name', multipart(file('', 'x'), ...TO_U1)),
  upload('the last file wins', multipart(file('a.exe', 'x'), file('b.txt', 'y'), ...TO_U1)),
  upload(
    'filename* is read as filename',
    multipart([`form-data; name="file"; filename*="UTF-8''a.txt"`, 'x'], ...TO_U1),
  ),
  upload(
    'base64 transfer encoding',
    `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="b.txt"\r\nContent-Transfer-Encoding: base64\r\n\r\naG9sYQ==\r\n${multipart(...TO_U1)}`,
  ),
  upload(
    'module of another letter case',
    multipart(
      file('a.txt', 'x'),
      field('linked_module', 'EVENTOS'),
      field('linked_record_id', 'PARITY-EVID-U1'),
    ),
  ),
  // A cut inside a surrogate pair: notes and author reach only the row (U+FFFD); document type
  // and verification also reach the record's JSON as a lone "\\ud83d", which jsonb refuses (500).
  upload(
    'notes cut inside an emoji',
    multipart(file('a.txt', 'x'), ...TO_U1, field('notes', `${'n'.repeat(999)}😀`)),
  ),
  upload(
    'author cut inside an emoji',
    multipart(file('a.txt', 'x'), ...TO_U1, field('author', `${'a'.repeat(159)}😀`)),
  ),
  upload(
    'document type cut inside an emoji',
    multipart(file('a.txt', 'x'), ...TO_U1, field('document_type', `${'d'.repeat(119)}😀`)),
  ),
  upload(
    'verification cut inside an emoji',
    multipart(file('a.txt', 'x'), ...TO_U1, field('verification', `${'v'.repeat(79)}😀`)),
  ),
  // Refusals: nothing is stored.
  upload(
    'unknown module',
    multipart(
      file('a.txt', 'x'),
      field('linked_module', 'planetas'),
      field('linked_record_id', 'PARITY-EVID-U1'),
    ),
  ),
  upload('an executable', multipart(file('script.exe', 'MZ'), ...TO_U1)),
  upload('a double extension', multipart(file('factura.pdf.exe', '%PDF-'), ...TO_U1)),
  upload('content that is not a PDF', multipart(file('falso.pdf', 'MZ not a pdf'), ...TO_U1)),
  upload(
    'HTML renamed as an image',
    multipart(file('foto.png', '<html><script>x</script>'), ...TO_U1),
  ),
  upload('a control character in a text file', multipart(file('a.txt', 'a\u0001b'), ...TO_U1)),
  upload('an empty file', multipart(file('vacio.txt', ''), ...TO_U1)),
  upload(
    'a missing record',
    multipart(
      file('a.txt', 'x'),
      field('linked_module', 'eventos'),
      field('linked_record_id', 'PARITY-EVID-NONE'),
    ),
  ),
  upload(
    'a record of another project',
    multipart(
      file('a.txt', 'x'),
      field('linked_module', 'eventos'),
      field('linked_record_id', 'PARITY-EVID-OTRO'),
    ),
  ),
  upload(
    'a record id with NUL',
    multipart(
      file('a.txt', 'x'),
      field('linked_module', 'eventos'),
      field('linked_record_id', 'a\u0000b'),
    ),
  ),
  upload(
    'a record id of 201 characters',
    multipart(
      file('a.txt', 'x'),
      field('linked_module', 'eventos'),
      field('linked_record_id', 'x'.repeat(201)),
    ),
  ),
  upload('NUL in the notes', multipart(file('a.txt', 'x'), ...TO_U1, field('notes', 'a\u0000b'))),
  upload('no file', multipart(...TO_U1)),
  upload('the file sent as text', multipart(field('file', 'x'), ...TO_U1)),
  upload(
    'no linked_module',
    multipart(file('a.txt', 'x'), field('linked_record_id', 'PARITY-EVID-U1')),
  ),
  upload('no linked_record_id', multipart(file('a.txt', 'x'), field('linked_module', 'eventos'))),
  upload(
    'linked_module sent as a file',
    multipart(
      file('a.txt', 'x'),
      ['form-data; name="linked_module"; filename="m"', 'eventos'],
      field('linked_record_id', 'PARITY-EVID-U1'),
    ),
  ),
  upload(
    'a malformed multipart body',
    `--${BOUNDARY}\r\nContent-Disposition: form-data; name=file\r\n\r\nx\r\n--${BOUNDARY}--`,
  ),
  upload(
    'a multipart body without a boundary',
    multipart(file('a.txt', 'x'), ...TO_U1),
    {},
    'multipart/form-data',
  ),
  upload(
    'a URL-encoded body',
    'file=x&linked_module=eventos&linked_record_id=PARITY-EVID-U1',
    {},
    'application/x-www-form-urlencoded',
  ),
  upload('a JSON body', '{"file":"x"}', {}, 'application/json'),
  upload('a text body', 'file=x', {}, 'text/plain'),
  // Gates before the route.
  upload('without a session', multipart(file('a.txt', 'x'), ...TO_U1), {}, MULTIPART, ['auth']),
  upload('without Origin', multipart(file('a.txt', 'x'), ...TO_U1), {}, MULTIPART, ['sameOrigin']),
  upload('two projects need a choice', multipart(file('a.txt', 'x'), ...TO_U1), { auth: 'multi' }),
  upload('project_id of another project', multipart(file('a.txt', 'x'), ...TO_U1), {
    path: `${LIST}?project_id=OTRO`,
  }),
  upload('a project without a grant', multipart(file('a.txt', 'x'), ...TO_U1), {
    headers: { 'content-type': MULTIPART, ...OTHER_SCOPE },
  }),
  upload('trailing slash', multipart(file('a.txt', 'x'), ...TO_U1), { path: `${LIST}/` }),
];

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
  // The role gate refuses uploads for consulta in both APIs.
  {
    name: 'uploads: write refused for the read-only role',
    method: 'POST',
    path: LIST,
    auth: 'consulta',
    sameOrigin: true,
    body: { form: { linked_module: 'fuentes', linked_record_id: 'PARITY-EVID-F1' } },
  },

  ...fileRoute('download'),
  fileCase('download', 'a text file whose object is gone', 'PARITY-ADJ-TXT'),
  fileCase('download', 'an image whose object is gone', 'PARITY-ADJ-IMG'),
  fileCase('download', 'a key outside the storage layout', 'PARITY-ADJ-1'),
  fileCase('download', 'restricted record as admin', 'PARITY-ADJ-RT'),
  fileCase('download', 'restricted record as consulta', 'PARITY-ADJ-RT', 'consulta'),
  fileCase('download', 'id of another project', 'PARITY-ADJ-AJENA'),
  fileCase(
    'download',
    'id of another project with its scope',
    'PARITY-ADJ-AJENA',
    'admin',
    OTHER_SCOPE,
  ),
  fileCase('download', 'missing id', 'PARITY-ADJ-NONE'),
  fileCase('download', 'id with an encoded slash', '..%2F..%2Fetc%2Fpasswd'),
  fileCase('download', 'id with NUL', 'a%00b'),
  fileCase('download', 'id of 65 characters', 'A'.repeat(65)),
  fileCase('download', 'undecodable id', 'bad%E0%A4'),
  {
    name: 'download: trailing slash',
    method: 'GET',
    path: `${detail('PARITY-ADJ-TXT')}/download/`,
    auth: 'admin',
  },
  {
    name: 'download: written with POST',
    method: 'POST',
    path: `${detail('PARITY-ADJ-TXT')}/download`,
    auth: 'admin',
    sameOrigin: true,
  },

  ...fileRoute('preview'),
  fileCase('preview', 'an image needs no bytes', 'PARITY-ADJ-IMG'),
  fileCase('preview', 'a spreadsheet is download-only', 'PARITY-ADJ-XLS'),
  fileCase('preview', 'a PDF whose object is gone', 'PARITY-ADJ-PDF'),
  fileCase('preview', 'an image as consulta', 'PARITY-ADJ-IMG', 'consulta'),
  fileCase('preview', 'restricted record as admin', 'PARITY-ADJ-RT'),
  fileCase('preview', 'restricted record as consulta', 'PARITY-ADJ-RT', 'consulta'),
  fileCase('preview', 'id of another project', 'PARITY-ADJ-AJENA'),
  fileCase(
    'preview',
    'id of another project with its scope',
    'PARITY-ADJ-AJENA',
    'admin',
    OTHER_SCOPE,
  ),
  fileCase('preview', 'image of the second project as multi', 'PARITY-ADJ-IMG', 'multi', SECOND),
  fileCase('preview', 'missing id', 'PARITY-ADJ-NONE'),
  fileCase('preview', 'id with NUL', 'a%00b'),
  fileCase('preview', 'id of 65 characters', 'A'.repeat(65)),

  ...uploads,
];

/** The gates every file route gets, on an attachment whose object is gone. */
function fileRoute(route: 'download' | 'preview'): ParityCase[] {
  return common(route, `${detail('PARITY-ADJ-TXT')}/${route}`);
}

function fileCase(
  route: 'download' | 'preview',
  name: string,
  id: string,
  auth: ParityCase['auth'] = 'admin',
  headers?: Readonly<Record<string, string>>,
): ParityCase {
  return {
    name: `${route}: ${name}`,
    method: 'GET',
    path: `${detail(id)}/${route}`,
    auth,
    ...(headers ? { headers } : {}),
  };
}
