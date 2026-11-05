import { crc32 } from 'node:zlib';
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

/**
 * Rows the write cases decide (T46). Both APIs run each case at once on one database, so every
 * write names rows of its own per API (`vary`): the TypeScript side decides the WT rows, the Go
 * side the WG rows, identical except for their id and theme. A read filtered by that theme then
 * shows each API its own rows, so a write that did not persist shows as a difference.
 */
const WRITE_SHA = 'ef56'.repeat(16);
const pending = (id: string, theme: string, excerpt: string) =>
  `(${[SECHURA, id, 'PRJ-SECHURA', 'acta-escrita.pdf', WRITE_SHA, 'página 3', theme, excerpt, 'Contrastar con el acta', 'pendiente', '', '', '2026-02-10 00:00:00+00', '2026-02-10 00:00:00+00'].map(quote).join(', ')})`;
const WRITE_SEED = `
INSERT INTO document_review (tenant_id, id, project_id, source_file, source_sha256, location, theme,
  excerpt, action, status, reviewer, note, created_at, updated_at) VALUES
  ${['T', 'G']
    .flatMap((side) => [
      pending(`PARITY-DOC-W${side}1`, `Parity-D${side}`, 'Decisión individual'),
      pending(`PARITY-DOC-W${side}2`, `Parity-B${side}`, 'Primera decisión en bloque'),
      pending(`PARITY-DOC-W${side}3`, `Parity-B${side}`, 'Segunda decisión en bloque'),
      pending(`PARITY-DOC-W${side}4`, `Parity-K${side}`, 'Decisión por identificador'),
      pending(`PARITY-DOC-W${side}5`, `Parity-K${side}`, 'Descartado por identificador'),
    ])
    .join(',\n  ')}
ON CONFLICT DO NOTHING;
`;

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
${WRITE_SEED}
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

// ---- uploads: reading, comparing and reporting (T46) ----------------------------------------

const BOUNDARY = 'ParityDocsBoundary9x';
const MULTIPART = { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` };
type Part = readonly [disposition: string, content: string];
const file = (name: string, content: string, field = 'file'): Part => [
  `form-data; name="${field}"; filename="${name}"\r\nContent-Type: application/octet-stream`,
  content,
];
const field = (name: string, value: string): Part => [`form-data; name="${name}"`, value];
const multipart = (...parts: Part[]) =>
  `${parts.map(([d, c]) => `--${BOUNDARY}\r\nContent-Disposition: ${d}\r\n\r\n${c}\r\n`).join('')}--${BOUNDARY}--\r\n`;

const le = (n: number, bytes: number) =>
  Array.from({ length: bytes }, (_, i) => String.fromCharCode((n >>> (8 * i)) & 0xff)).join('');
const ascii = (n: number, bytes: number) =>
  le(n, bytes)
    .split('')
    .every((c) => c.charCodeAt(0) < 0x80);

/**
 * A Word package whose every byte is ASCII: one stored (uncompressed) word/document.xml, padded
 * until its CRC-32, sizes and offsets have no byte above 0x7F. The runner sends raw bodies as
 * text, which keeps such bytes intact (a real, deflated .docx would not survive).
 */
const asciiDocx = (markup: string) => {
  const name = 'word/document.xml';
  // Characters past ASCII become XML character references, which the readers decode.
  const body = markup.replace(/[^ -~]/gu, (c) => `&#${c.codePointAt(0)};`);
  for (let pad = 0; pad < 4096; pad++) {
    const xml = `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>${' '.repeat(pad)}`;
    const crc = crc32(Buffer.from(xml, 'latin1'));
    const central = 30 + name.length + xml.length;
    if (
      ![
        [crc, 4],
        [xml.length, 4],
        [central, 4],
      ].every(([n, b]) => ascii(n as number, b as number))
    )
      continue;
    const common = `\x14\x00\x00\x00\x00\x00\x00\x00\x21\x00${le(crc, 4)}${le(xml.length, 4)}${le(xml.length, 4)}${le(name.length, 2)}\x00\x00`;
    const local = `PK\x03\x04${common}${name}${xml}`;
    const cd = `PK\x01\x02\x14\x00${common}\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00${name}`;
    return `${local}${cd}PK\x05\x06\x00\x00\x00\x00\x01\x00\x01\x00${le(cd.length, 4)}${le(central, 4)}\x00\x00`;
  }
  throw new Error('no ASCII-only package');
};

const ACTA =
  'Acta de reunión.\nLa comunidad presentó una demanda de empleo local en la asamblea.\nEl comité acordó un plazo de seguimiento para el compromiso y su verificación.\n';
const ACTA_B =
  'Segunda acta. La asamblea de la comunidad reiteró la demanda de empleo local y la capacitación.\nEl comité revisó el plazo de seguimiento del compromiso.';
const DOCX = asciiDocx(
  '<w:p><w:r><w:t>La mesa de diálogo acordó una nueva reunión con la comunidad.</w:t></w:r></w:p><w:p/>' +
    '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Responsable</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Seguimiento mensual del acuerdo &amp; compromiso</w:t></w:r></w:p></w:tc></w:tr></w:tbl>',
);

/** Case fields to override; `undefined` removes the default (a session, same-origin). */
type Extra = { readonly [K in keyof ParityCase]?: ParityCase[K] | undefined };
const defined = (c: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(c).filter(([, v]) => v !== undefined)) as ParityCase;

const upload = (
  route: 'analyze' | 'report.docx' | 'compare',
  label: string,
  body: string,
  extra: Extra = {},
): ParityCase =>
  defined({
    name: `documents ${route}: ${label}`,
    method: 'POST',
    path: `/system/document-lab/${route}`,
    auth: 'admin',
    sameOrigin: true,
    headers: MULTIPART,
    body: { raw: body },
    ...(route === 'report.docx' ? {} : { normalize: ['generated_at'] }),
    ...extra,
  });

const UPLOAD_CASES: readonly ParityCase[] = [
  upload('analyze', 'a text document', multipart(file('Acta de reunión.TXT', ACTA))),
  upload(
    'analyze',
    'Markdown with a byte order mark and CRLF',
    multipart(file('notas.md', `\ufeff${ACTA.replaceAll('\n', '\r\n')}`)),
  ),
  upload('analyze', 'a Word document', multipart(file('acta.docx', DOCX))),
  upload(
    'analyze',
    'a broken Word document',
    multipart(file('roto.docx', 'PK\x03\x04 no es un paquete')),
  ),
  upload('analyze', 'text without findings', multipart(file('vacio.txt', '  \n\t\n'))),
  upload('analyze', 'an empty file', multipart(file('vacio.txt', ''))),
  upload('analyze', 'an empty PDF', multipart(file('vacio.pdf', ''))),
  upload('analyze', 'an unsupported extension', multipart(file('tabla.xlsx', 'x'))),
  upload('analyze', 'no file', multipart(field('nota', 'x'))),
  upload(
    'analyze',
    'the project of the scope',
    multipart(file('a.txt', ACTA), field('project_id', 'PRJ-SECHURA')),
  ),
  upload(
    'analyze',
    'another project',
    multipart(file('a.txt', ACTA), field('project_id', 'PRJ-B')),
  ),
  upload('analyze', 'an invalid form', `--${BOUNDARY}\r\nroto`),
  upload('analyze', 'as the read-only role', multipart(file('a.txt', ACTA)), { auth: 'consulta' }),
  upload('analyze', 'in the second project', multipart(file('a.txt', ACTA)), {
    auth: 'multi',
    headers: { ...MULTIPART, 'x-sipges-scope': SECOND },
  }),
  upload('analyze', 'before choosing a project', multipart(file('a.txt', ACTA)), { auth: 'multi' }),
  upload('analyze', 'without a session', multipart(file('a.txt', ACTA)), { auth: undefined }),
  upload('analyze', 'without Origin', multipart(file('a.txt', ACTA)), { sameOrigin: undefined }),
  upload(
    'compare',
    'two documents',
    multipart(file('a.txt', ACTA, 'file_a'), file('b.md', ACTA_B, 'file_b')),
  ),
  upload(
    'compare',
    'a Word document and a text',
    multipart(file('a.docx', DOCX, 'file_a'), file('b.txt', ACTA, 'file_b')),
  ),
  upload('compare', 'without the second file', multipart(file('a.txt', ACTA, 'file_a'))),
  upload(
    'compare',
    'an empty second file',
    multipart(file('a.txt', ACTA, 'file_a'), file('b.txt', '', 'file_b')),
  ),
  upload(
    'compare',
    'an unsupported second file',
    multipart(file('a.txt', ACTA, 'file_a'), file('b.exe', 'x', 'file_b')),
  ),
  upload(
    'compare',
    'as the read-only role',
    multipart(file('a.txt', ACTA, 'file_a'), file('b.txt', ACTA_B, 'file_b')),
    { auth: 'consulta' },
  ),
  upload('report.docx', 'no file', multipart(field('x', 'y'))),
  upload('report.docx', 'an empty file', multipart(file('a.md', ''))),
  upload('report.docx', 'an unsupported extension', multipart(file('a.odt', 'x'))),
  upload('report.docx', 'text without findings', multipart(file('a.txt', '\n'))),
  upload(
    'report.docx',
    'another project',
    multipart(file('a.txt', ACTA), field('project_id', 'PARITY/OTRO')),
  ),
  upload('report.docx', 'without a session', multipart(file('a.txt', ACTA)), { auth: undefined }),
];

// ---- review writes (T46): each followed by a read of what it stored ------------------------

const write = (
  label: string,
  method: 'POST' | 'PATCH',
  path: string,
  json: unknown,
  extra: Extra = {},
): ParityCase =>
  defined({
    name: `documents review write: ${label}`,
    method,
    path,
    auth: 'admin',
    sameOrigin: true,
    body: { json },
    ...extra,
  });

/** A read of one API's own rows: its theme is `{t}`, so the fields that name it are normalized. */
const readBack = (label: string, theme: { ts: string; go: string }): ParityCase => ({
  name: `documents review write: ${label}`,
  method: 'GET',
  path: `${PATH}?theme={t}`,
  auth: 'admin',
  vary: { t: theme },
  normalize: [
    'items.*.id',
    'items.*.theme',
    'items.*.record.id',
    'items.*.created_at',
    'items.*.updated_at',
  ],
});

const DECIDE = { ts: 'Parity-DT', go: 'Parity-DG' };
const BULK = { ts: 'Parity-BT', go: 'Parity-BG' };
const IMPORTED = { ts: 'Parity-IT', go: 'Parity-IG' };
const BY_ID = { ts: 'Parity-KT', go: 'Parity-KG' };

const importBatch = {
  filename: 'acta-importada.pdf',
  sha256: WRITE_SHA,
  items: [
    {
      tema: '{i}',
      fragmento: 'La comunidad pidió empleo local.',
      ubicacion: 'Página 1',
      accion_sugerida: 'Contrastar',
    },
    { tema: '{i}', fragmento: 'La comunidad pidió empleo local.', ubicacion: 'Página 1' },
    { tema: '{i}', fragmento: 7, ubicacion: true, accion_sugerida: { a: [1, null] } },
    { tema: '{i}', fragmento: 'Sin ubicación' },
  ],
};

const WRITE_CASES: readonly ParityCase[] = [
  // A single decision approves, creates its record once and is audited.
  readBack('the pending row before deciding', DECIDE),
  write(
    'approve one finding',
    'PATCH',
    `${PATH}/{id}`,
    { status: 'aceptado_para_revision', reviewer: 'Equipo', note: 'Ver acta' },
    {
      vary: { id: { ts: 'PARITY-DOC-WT1', go: 'PARITY-DOC-WG1' } },
      normalize: ['id', 'record.id'],
    },
  ),
  readBack('the approved row and its record', DECIDE),
  write(
    'approve it again: the record already exists',
    'PATCH',
    `${PATH}/{id}`,
    { status: 'aceptado_para_revision' },
    {
      vary: { id: { ts: 'PARITY-DOC-WT1', go: 'PARITY-DOC-WG1' } },
      normalize: ['id', 'record.id'],
    },
  ),
  write('corroborate without a note', 'PATCH', `${PATH}/PARITY-DOC-WT1`, {
    status: 'corroborado_documentalmente',
    note: ' ',
  }),
  write('an unknown status', 'PATCH', `${PATH}/PARITY-DOC-WT1`, { status: 'cerrado' }),
  write('a body of wrong types', 'PATCH', `${PATH}/PARITY-DOC-WT1`, { status: 1, reviewer: null }),
  write('a body that is not JSON', 'PATCH', `${PATH}/PARITY-DOC-WT1`, null, {
    body: { raw: '{"status":' },
  }),
  write('a finding of another tenant', 'PATCH', `${PATH}/PARITY-DOC-9`, { status: 'descartado' }),
  write(
    'a finding of the second project from the default one',
    'PATCH',
    `${PATH}/PARITY-DOC-B1-NO`,
    { status: 'descartado' },
  ),
  write('an id of 65 characters', 'PATCH', `${PATH}/${'x'.repeat(65)}`, { status: 'descartado' }),
  write(
    'a decision without a session',
    'PATCH',
    `${PATH}/PARITY-DOC-WT1`,
    { status: 'descartado' },
    { auth: undefined },
  ),
  write(
    'a decision without Origin',
    'PATCH',
    `${PATH}/PARITY-DOC-WT1`,
    { status: 'descartado' },
    { sameOrigin: undefined },
  ),
  // Bulk: a dry run writes nothing; the real run decides the theme's pending rows.
  write(
    'bulk dry run by theme',
    'POST',
    `${PATH}/bulk`,
    { theme: '{b}', status: 'aceptado_para_revision', dry_run: true },
    {
      vary: { b: BULK },
    },
  ),
  readBack('the rows a dry run left pending', BULK),
  write(
    'bulk approval by theme',
    'POST',
    `${PATH}/bulk`,
    { theme: '{b}', status: 'aceptado_para_revision', note: 'En bloque' },
    {
      vary: { b: BULK },
    },
  ),
  readBack('the rows a bulk approval decided', BULK),
  write(
    'bulk approval by theme again: nothing left',
    'POST',
    `${PATH}/bulk`,
    { theme: '{b}', status: 'aceptado_para_revision' },
    {
      vary: { b: BULK },
    },
  ),
  write(
    'bulk by ids, skipping decided, unknown and foreign ids',
    'POST',
    `${PATH}/bulk`,
    {
      ids: ['{k}4', '{k}5', '{k}4', 'PARITY-DOC-1', 'PARITY-DOC-9', 'NO-EXISTE'],
      status: 'descartado',
      note: 'Por identificador',
    },
    { vary: { k: { ts: 'PARITY-DOC-WT', go: 'PARITY-DOC-WG' } } },
  ),
  readBack('the rows decided by id', BY_ID),
  write('bulk with ids and a theme', 'POST', `${PATH}/bulk`, {
    ids: ['a'],
    theme: 'x',
    status: 'descartado',
  }),
  write('bulk with nothing to select', 'POST', `${PATH}/bulk`, { status: 'descartado' }),
  write('bulk back to pending', 'POST', `${PATH}/bulk`, { ids: ['a'], status: 'pendiente' }),
  write('bulk with an unknown key', 'POST', `${PATH}/bulk`, {
    ids: ['a'],
    status: 'descartado',
    extra: true,
  }),
  write('bulk with many problems', 'POST', `${PATH}/bulk`, {
    ids: [],
    theme: 1,
    source_sha256: 'x',
    status: 'x',
    note: 2,
    dry_run: 0,
    otro: 1,
  }),
  write('bulk corroboration without a note', 'POST', `${PATH}/bulk`, {
    ids: ['a'],
    status: 'corroborado_documentalmente',
  }),
  write('bulk with too many ids', 'POST', `${PATH}/bulk`, {
    ids: Array.from({ length: 1001 }, (_, i) => `id-${i}`),
    status: 'descartado',
  }),
  write(
    'bulk as the second project of multi',
    'POST',
    `${PATH}/bulk`,
    { ids: ['PARITY-DOC-B1'], status: 'descartado', dry_run: true },
    {
      auth: 'multi',
      headers: { 'x-sipges-scope': SECOND },
    },
  ),
  // Import stores excerpts once; a re-import adds nothing.
  write('import a batch', 'POST', `${PATH}/import`, importBatch, { vary: { i: IMPORTED } }),
  readBack('the imported excerpts', IMPORTED),
  write('import the same batch again', 'POST', `${PATH}/import`, importBatch, {
    vary: { i: IMPORTED },
  }),
  write(
    'import with an invalid SHA-256',
    'POST',
    `${PATH}/import`,
    { ...importBatch, sha256: 'ABC' },
    { vary: { i: IMPORTED } },
  ),
  write('import more than 75 findings', 'POST', `${PATH}/import`, {
    filename: 'a',
    sha256: WRITE_SHA,
    items: Array.from({ length: 76 }, () => ({})),
  }),
  write('import with NUL in a field', 'POST', `${PATH}/import`, {
    filename: 'a',
    sha256: WRITE_SHA,
    items: [{ tema: 'x', fragmento: 'a\u0000b', ubicacion: 'p' }],
  }),
  write('import with missing fields', 'POST', `${PATH}/import`, {}),
  write('import with items of wrong types', 'POST', `${PATH}/import`, {
    filename: 'a',
    sha256: WRITE_SHA,
    items: [1, null, []],
  }),
  write(
    'import naming another project',
    'POST',
    `${PATH}/import`,
    { ...importBatch, project_id: 'PRJ-B' },
    { vary: { i: IMPORTED } },
  ),
  write('import as the read-only role', 'POST', `${PATH}/import`, importBatch, {
    auth: 'consulta',
    vary: { i: IMPORTED },
  }),
  write('import without a session', 'POST', `${PATH}/import`, importBatch, {
    auth: undefined,
    vary: { i: IMPORTED },
  }),
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
  ...UPLOAD_CASES,
  ...WRITE_CASES,
];
