// Records the TypeScript document lab on synthetic inputs, for the Go tests of
// internal/documents and internal/platform/doctext:
//
// - analyses: createDocumentLabService(...).analyze and .compare with the real readers and a
//   fixed clock, on TXT, Markdown and DOCX inputs;
// - docx: readDocx of document-reader.ts on Word packages built here (well-formed and hostile);
// - reports: every part of docxRenderer's package for the lab report of some analyses (the dates
//   of docProps/core.xml replaced by DATE);
// - records: reviewRecordFields for every target module and status;
// - http: documentLabRoutes with a fake service on raw requests (validation, multipart reading,
//   size limits and error mapping), with the calls the fake received.
//
// Run from the repository root after changing either side:
//
//   node apps/api-go/internal/documents/testdata/generate.mjs          # rewrites fixtures.json
//   node apps/api-go/internal/documents/testdata/generate.mjs --check  # exit 1 when it drifted
//
// Every input is synthetic, written here.
// Zip entry dates are local times: the zone is fixed so every machine writes the same bytes.
process.env.TZ = 'UTC';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { strToU8, unzipSync, zipSync } from '../../../../api/node_modules/fflate/esm/index.mjs';
import { Hono } from '../../../../api/node_modules/hono/dist/index.js';
import { format, resolveConfig } from 'prettier';
import { createDocumentLabService } from '../../../../api/src/contexts/documents/application/index.ts';
import { reviewRecordFields } from '../../../../api/src/contexts/documents/domain/index.ts';
import { documentLabRoutes } from '../../../../api/src/contexts/documents/http/document-lab-routes.ts';
import {
  docxRenderer,
  inlineDocumentReader,
} from '../../../../api/src/contexts/documents/infrastructure/index.ts';

const OUT = fileURLToPath(new URL('./fixtures.json', import.meta.url));
const b64 = (bytes) => Buffer.from(bytes).toString('base64');
const utf8 = (text) => new TextEncoder().encode(text);
const NOW = new Date('2026-03-04T05:06:07.890Z');

// ---- Word packages -------------------------------------------------------------------------

/** Entry dates of the packages built here, so the fixtures do not change between runs. */
const ZIP_DATE = new Date('2026-01-02T03:04:06');
const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const docXml = (body) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W}><w:body>${body}</w:body></w:document>`;
const p = (text) => `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
const pack = (xml, { name = 'word/document.xml', level = 6, extra = {} } = {}) =>
  zipSync({
    [name]: [typeof xml === 'string' ? strToU8(xml) : xml, { level, mtime: ZIP_DATE }],
    ...extra,
  });

const DOCX = [
  [
    'paragraphs and a table',
    pack(
      docXml(
        p('La comunidad presentó una demanda de empleo local en la asamblea.') +
          '<w:p/>' +
          p('  La mesa de diálogo acordó una nueva reunión.  ') +
          '<w:tbl><w:tr><w:tc>' +
          p('Responsable') +
          '</w:tc><w:tc>' +
          p('Plazo') +
          '</w:tc></w:tr>' +
          '<w:tr><w:tc>' +
          p('Comité') +
          p('de seguimiento') +
          '</w:tc><w:tc>' +
          p('Seguimiento mensual del acuerdo y compromiso') +
          '</w:tc></w:tr>' +
          '<w:tr><w:tc>' +
          p(' ') +
          '</w:tc><w:tc>' +
          p('|') +
          '</w:tc></w:tr></w:tbl>',
      ),
    ),
  ],
  [
    'stored, not deflated',
    pack(docXml(p('Acta de compromiso con plazo y responsable definidos.')), { level: 0 }),
  ],
  [
    'runs, tabs, breaks and skipped content',
    pack(
      docXml(
        '<w:p><w:pPr><w:pStyle w:val="Title"/><w:rPr><w:t>no</w:t></w:rPr></w:pPr>' +
          '<w:r><w:rPr><w:b/></w:rPr><w:t>Primera</w:t></w:r><w:r><w:tab/><w:t>tabulada</w:t><w:br/><w:t>salto</w:t><w:cr/></w:r>' +
          '<w:hyperlink><w:r><w:t>enlace</w:t></w:r></w:hyperlink>' +
          '<w:r><w:drawing><w:t>dibujo</w:t></w:drawing><w:pict><w:t>pict</w:t></w:pict></w:r>' +
          '<mc:AlternateContent><w:t>alt</w:t></mc:AlternateContent><w:ins><w:r><w:t>insertado</w:t></w:r></w:ins>' +
          '<w:t>suelto<w:b/>dentro</w:t></w:p>',
      ),
    ),
  ],
  [
    'entities and references',
    pack(
      docXml(
        p(
          '&amp; &lt; &gt; &quot; &apos; &#65; &#x42; &#x4a; &#0; &nbsp; &constructor; &AMP; &#X41; &#x; &; &amp',
        ) + p('&#x1F600; &#128512; &#xE9; &#233;'),
      ),
    ),
  ],
  [
    'comments, processing instructions and stray markup',
    pack(
      '<?xml version="1.0"?><!-- c --><!DOCTYPE x><w:document><?pi x?><w:body><!-- <w:p> -->' +
        p('a < b y c > d en el texto del acta') +
        '<w:p><w:r><w:t>x</w:t></w:r><w:r ></w:r ><w:t/></w:p>' +
        '<w:p attr="1>2"><w:r><w:t>uno</w:t></w:r></w:p></w:body></w:document>',
    ),
  ],
  [
    'nested bodies: the first document with a body',
    pack(
      '<root><w:document></w:document><w:document><w:body>' +
        p('segundo documento') +
        '</w:body></w:document></root>' +
        '<w:document><w:body>' +
        p('tercero') +
        '</w:body></w:document>',
    ),
  ],
  [
    'byte order mark and invalid UTF-8',
    pack(
      new Uint8Array([
        0xef,
        0xbb,
        0xbf,
        ...strToU8(docXml(p('Café'))).slice(0, 120),
        0xff,
        0xc3,
        ...strToU8(docXml(p('Café'))).slice(120),
      ]),
    ),
  ],
  [
    'a UTF-8 name with a byte order mark',
    (() => {
      const z = pack(docXml(p('nombre con BOM')), { name: '\ufeffword/document.xml' });
      return z;
    })(),
  ],
  [
    'two parts of the same name: the last wins',
    (() => {
      const a = pack(docXml(p('primero')));
      const b = pack(docXml(p('segundo')), { name: 'word/document.xmm' });
      // rename the second entry in both headers so the package holds the name twice
      const bytes = new Uint8Array([...a.slice(0, 0)]);
      void bytes;
      return mergeZips(a, b);
    })(),
  ],
  ['no body', pack(`<w:document ${W}><w:other/></w:document>`)],
  ['unclosed element', pack(docXml('<w:p><w:r><w:t>abierto</w:t></w:r>'))],
  ['mismatched close', pack(docXml('<w:p><w:r></w:p></w:r>'))],
  ['close at the root', pack(docXml(p('x')) + '</w:extra>')],
  ['reference past U+10FFFF', pack(docXml(p('&#x110000;')))],
  ['reference far past U+10FFFF', pack(docXml(p('&#99999999999999999999;')))],
  ['no document part', pack(docXml(p('x')), { name: 'word/other.xml' })],
  ['not a zip', utf8('PK not a zip')],
  ['empty zip', zipSync({})],
  ['empty file', new Uint8Array()],
  ['truncated', pack(docXml(p('truncado'))).slice(0, 40)],
  [
    'unknown compression method',
    (() => {
      const z = pack(docXml(p('x')), { level: 0 });
      // central directory method field (offset 10 of the entry) set to 12 (bzip2)
      const cd = findCentral(z);
      z[cd + 10] = 12;
      return z;
    })(),
  ],
  [
    'a sibling part does not matter',
    pack(docXml(p('con estilos')), {
      extra: { 'word/styles.xml': [strToU8('<x/>'), { level: 6, mtime: ZIP_DATE }] },
    }),
  ],
  [
    'deeply nested runs',
    pack(docXml(`<w:p>${'<w:x>'.repeat(300)}<w:t>hondo</w:t>${'</w:x>'.repeat(300)}</w:p>`)),
  ],
];

function findCentral(z) {
  for (let i = z.length - 22; i >= 0; i--) {
    if (z[i] === 0x50 && z[i + 1] === 0x4b && z[i + 2] === 0x05 && z[i + 3] === 0x06) {
      return z[i + 16] | (z[i + 17] << 8) | (z[i + 18] << 16) | (z[i + 19] << 24);
    }
  }
  throw new Error('no central directory');
}

/** Both zips' entries in one package, with the second renamed to word/document.xml. */
function mergeZips(a, b) {
  const rename = (z) => {
    const out = new Uint8Array(z);
    const text = new TextDecoder('latin1').decode(out);
    for (
      let i = text.indexOf('word/document.xmm');
      i >= 0;
      i = text.indexOf('word/document.xmm', i + 1)
    )
      out[i + 16] = 0x6c; // 'm' → 'l'
    return out;
  };
  const second = rename(b);
  const parse = (z) => {
    const cd = findCentral(z);
    const eocd = z.length - 22;
    return { local: z.slice(0, cd), central: z.slice(cd, eocd) };
  };
  const pa = parse(a);
  const pb = parse(second);
  const central = new Uint8Array(pb.central);
  // shift the second entry's local header offset past the first package's local data
  const offset = central[42] | (central[43] << 8) | (central[44] << 16) | (central[45] << 24);
  const moved = offset + pa.local.length;
  central.set([moved & 0xff, (moved >> 8) & 0xff, (moved >> 16) & 0xff, (moved >>> 24) & 0xff], 42);
  const local = new Uint8Array([...pa.local, ...pb.local]);
  const cdStart = local.length;
  const allCentral = new Uint8Array([...pa.central, ...central]);
  const eocd = new Uint8Array(22);
  eocd.set([0x50, 0x4b, 0x05, 0x06]);
  eocd[8] = 2;
  eocd[10] = 2;
  eocd.set([allCentral.length & 0xff, (allCentral.length >> 8) & 0xff, 0, 0], 12);
  eocd.set([cdStart & 0xff, (cdStart >> 8) & 0xff, (cdStart >> 16) & 0xff, 0], 16);
  return new Uint8Array([...local, ...allCentral, ...eocd]);
}

const readDocx = async (bytes) => {
  try {
    return { content: await inlineDocumentReader.readDocx(bytes) };
  } catch {
    return { error: true };
  }
};

// ---- analyses, comparisons and reports ------------------------------------------------------

const lab = createDocumentLabService({
  reader: inlineDocumentReader,
  renderer: docxRenderer,
  reviews: {},
  records: {},
  clock: { now: () => NOW },
  randomHex: () => '0'.repeat(32),
  maxUploadBytes: 1024 * 1024,
});

const LONG = 'La comunidad de la asamblea revisó el mandato y la vigencia de la junta directiva. ';
const TEXTS = [
  [
    'acta.txt',
    `Acta de reunión.\nLa comunidad presentó una demanda de empleo local en la asamblea.\nEl comité acordó un plazo de seguimiento para el compromiso.\n`,
  ],
  ['vacio.txt', '   \n\t\n'],
  ['corto.txt', 'Agua.\nSalud.\nmesa corta'],
  ['bom.txt', '\ufeff\ufeffLa evidencia de la denuncia requiere verificación de la fuente.'],
  [
    'saltos.md',
    'Primera oración sobre el agua y el suelo del territorio! Segunda sobre la inversión productiva?   Tercera: el diálogo y la negociación en la mesa.\r\nOtra línea con el impacto ambiental\u2028en el área de influencia.\u2029Fin\u0085del texto con salud y agua para la comunidad.',
  ],
  [
    'mayusculas.txt',
    'LA ELECCIÓN DE LA ASAMBLEA Y LA PETICIÓN DE CAPACITACIÓN PARA PROVEEDORES LOCALES.',
  ],
  [
    'acentos.txt',
    'Diálogo sin tilde: dialogo, reunion, negociacion y participacion de la comunidad en la mesa.',
  ],
  [
    'espacios.txt',
    `Muchos\u00a0espacios\u2003raros\u3000en una oración sobre el acuerdo y el compromiso.\vVertical\fformfeed con demanda y reclamo de la comunidad.`,
  ],
  ['largo.txt', LONG.repeat(10)],
  [
    'muchos.txt',
    Array.from(
      { length: 120 },
      (_, i) =>
        `Línea ${i}: la comunidad, el acuerdo, la demanda, el diálogo, el agua, la inversión y la evidencia.`,
    ).join('\n'),
  ],
  [
    'emoji.txt',
    'La comunidad 😀 presentó una petición por el agua del territorio 🌊 y la salud. ﬁn de la ﬃla.',
  ],
  ['invalido.txt', null],
  [
    'puntos.txt',
    'Fin. Inicio sin espacio.Otra?¿Pregunta sobre la demanda de empleo y la capacitación de proveedores!!  Y la mesa de diálogo con la comunidad... seguimiento del acuerdo.',
  ],
  [
    'tema-numerico.txt',
    'Desarrollo productivo y servicios de contratación local como oportunidad de beneficio.',
  ],
];
const textBytes = (name, text) =>
  text === null
    ? new Uint8Array([
        ...utf8('La comunidad presentó una demanda '),
        0xff,
        0xfe,
        0xc3,
        ...utf8(' de empleo local en la asamblea.'),
        0xe2,
        0x82,
      ])
    : utf8(text);

const ANALYSES = [];
for (const [name, text] of TEXTS) ANALYSES.push({ name, data: b64(textBytes(name, text)) });
for (const [name, bytes] of DOCX.slice(0, 8))
  ANALYSES.push({ name: `${name}.docx`, data: b64(bytes) });
ANALYSES.push({ name: 'informe.DOCX', data: b64(DOCX[0][1]) });
ANALYSES.push({
  name: '',
  data: b64(utf8('Sin nombre: la comunidad presentó una demanda de empleo.')),
});
ANALYSES.push({
  name: 'C:\\carpeta\\Acta final ñ.txt',
  data: b64(utf8('La comunidad presentó una demanda de empleo.')),
});
ANALYSES.push({ name: 'roto.docx', data: b64(utf8('PK not a zip')) });
ANALYSES.push({ name: 'nada.docx', data: b64(DOCX.find(([n]) => n === 'no body')[1]) });
ANALYSES.push({ name: 'x.exe', data: b64(utf8('x')) });
ANALYSES.push({ name: 'vacio.md', data: '' });

const result = (r) => (r.ok ? { value: r.value } : { error: r.error.kind });

const analyses = [];
for (const a of ANALYSES) {
  const file = { fileName: a.name, bytes: Buffer.from(a.data, 'base64') };
  analyses.push({ ...a, result: result(await lab.analyze(file, 'PRJ-SECHURA')) });
}

const PAIRS = [
  [0, 0],
  [0, 4],
  [8, 9],
  [9, 8],
  [12, 4],
  [1, 0],
  [0, ANALYSES.length - 2],
  [14, 9],
];
const comparisons = [];
for (const [i, j] of PAIRS) {
  const file = (n) => ({
    fileName: ANALYSES[n].name,
    bytes: Buffer.from(ANALYSES[n].data, 'base64'),
  });
  comparisons.push({
    a: i,
    b: j,
    result: result(await lab.compare(file(i), file(j), 'PRJ-SECHURA')),
  });
}

const REPORT_TEXTS = [
  ['acta.txt', TEXTS[0][1]],
  [
    'raro <&>.txt',
    'La comunidad "presentó" una demanda <de> empleo & capacitación \u0001\u0008\u000b\u000c\u001f\u007f en la asamblea.\tTab y\u2028separador.',
  ],
  ['vacio-de-hallazgos.txt', 'Una línea suficientemente larga sin términos del vocabulario.'],
  ['largo.txt', LONG.repeat(10)],
];
const decoder = new TextDecoder();
const VARYING = new Set(['word/document.xml', 'docProps/core.xml']);
const reports = [];
let reportParts;
for (const [name, text] of REPORT_TEXTS) {
  const r = await lab.report({ fileName: name, bytes: utf8(text) }, 'PRJ-SECHURA');
  if (!r.ok) throw new Error(`report ${name}: ${r.error.kind}`);
  const parts = Object.entries(unzipSync(r.value)).map(([part, bytes]) => [
    part,
    decoder
      .decode(bytes)
      .replace(/(<dcterms:(?:created|modified) xsi:type="dcterms:W3CDTF">)[^<]*/g, '$1DATE'),
  ]);
  // Every other part must be the same for every report: the Go renderer embeds them once.
  const fixed = parts.map(([part, xml]) => [part, VARYING.has(part) ? null : xml]);
  if (reportParts && JSON.stringify(reportParts) !== JSON.stringify(fixed))
    throw new Error(`report ${name}: a fixed part changed with the content`);
  reportParts = fixed;
  reports.push({ name, data: b64(utf8(text)), parts: parts.filter(([part]) => VARYING.has(part)) });
}

// ---- record fields ---------------------------------------------------------------------------

const THEMES = [
  'Actor (extracción automática)',
  'Representatividad y gobernanza',
  'Demandas e intereses',
  'Compromisos y trazabilidad',
  'Controversias y hechos compartidos',
  'Diálogo y construcción de consensos',
  'Oportunidades de valor compartido',
  'Territorio y ambiente',
  'Tema libre',
  '',
  'constructor',
];
const records = [];
for (const [i, theme] of THEMES.entries()) {
  for (const status of ['aceptado_para_revision', 'corroborado_documentalmente']) {
    const item = {
      id: `item-${i}`,
      projectId: 'PRJ-SECHURA',
      sourceFile: 'acta sintética.pdf',
      sourceSha256: 'ab'.repeat(32),
      location: `Página ${i}`,
      theme,
      excerpt: `Extracto ${i} con "comillas" y 😀`,
      action: i % 3 === 0 ? '' : `Acción ${i}`,
      status,
      reviewer: i % 2 === 0 ? '' : 'Equipo',
      note: i % 4 === 1 ? '' : `Nota ${i}`,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date(Date.UTC(2026, 1, 3, 23, 59, 59, 999)),
    };
    records.push({
      item: {
        ...item,
        createdAt: item.createdAt.toISOString(),
        updatedAt: item.updatedAt.toISOString(),
      },
      fields: Object.entries(reviewRecordFields(item, 'PRJ-SECHURA')),
    });
  }
}

// ---- HTTP: validation and multipart reading with a fake service ----------------------------

const MAX = 1000;
const calls = [];
const kindOf = (name) => /^err-([a-z_]+)\./.exec(name)?.[1];
const fileCall = (f) =>
  f.bytes.length > 512
    ? {
        fileName: f.fileName,
        sha256: createHash('sha256').update(f.bytes).digest('hex'),
        length: f.bytes.length,
      }
    : { fileName: f.fileName, data: b64(f.bytes) };
const fake = {
  maxUploadBytes: MAX,
  reportContentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  async analyze(file, projectId) {
    calls.push({ op: 'analyze', file: fileCall(file), projectId });
    const kind = kindOf(file.fileName);
    return kind ? { ok: false, error: { kind } } : { ok: true, value: { analyzed: file.fileName } };
  },
  async report(file, projectId) {
    calls.push({ op: 'report', file: fileCall(file), projectId });
    const kind = kindOf(file.fileName);
    return kind ? { ok: false, error: { kind } } : { ok: true, value: utf8('DOCX') };
  },
  async compare(a, b, projectId) {
    calls.push({ op: 'compare', a: fileCall(a), b: fileCall(b), projectId });
    const kind = kindOf(a.fileName) ?? kindOf(b.fileName);
    return kind ? { ok: false, error: { kind } } : { ok: true, value: { compared: true } };
  },
  async importReview(tenantId, batch) {
    calls.push({ op: 'import', tenantId, batch: JSON.parse(JSON.stringify(batch)) });
    const kind = /^err-([a-z_0-9]+)$/.exec(batch.filename)?.[1];
    return kind ? { ok: false, error: { kind } } : { ok: true, value: 3 };
  },
  async decide(tenantId, input) {
    calls.push({ op: 'decide', tenantId, input });
    const kind = /^err-([a-z_]+)$/.exec(input.id)?.[1];
    return kind
      ? { ok: false, error: { kind } }
      : { ok: true, value: { id: input.id, status: input.status, record: null } };
  },
  async decideMany(tenantId, input) {
    calls.push({ op: 'bulk', tenantId, input });
    const kind = /^err-([a-z_]+)$/.exec(input.note)?.[1];
    return kind
      ? { ok: false, error: { kind } }
      : {
          ok: true,
          value: {
            decided: 2,
            recordsCreated: 1,
            skipped: 0,
            remaining: 4,
            modules: [
              { module: 'hechos', label: 'Hechos compartidos', nuevos: 1, ya_existentes: 1 },
            ],
            problems: [],
          },
        };
  },
};

const app = new Hono();
app.use('*', async (c, next) => {
  c.set('scope', { companyId: 'SIPGES', projectId: 'PRJ-SECHURA' });
  c.set('identity', {
    username: 'analista.sintetica',
    fullName: c.req.header('x-test-full-name') ?? 'Analista Sintética',
  });
  await next();
});
app.route('/', documentLabRoutes(fake));

const BOUNDARY = 'ParityBoundary7MA4YWxk';
const MULTIPART = `multipart/form-data; boundary=${BOUNDARY}`;
const part = (disposition, content, type) =>
  `--${BOUNDARY}\r\nContent-Disposition: ${disposition}\r\n${type ? `Content-Type: ${type}\r\n` : ''}\r\n${content}\r\n`;
const file = (name, content, field = 'file') =>
  part(`form-data; name="${field}"; filename="${name}"`, content, 'application/octet-stream');
const field = (name, value) => part(`form-data; name="${name}"`, value);
const form = (...parts) => `${parts.join('')}--${BOUNDARY}--\r\n`;

const REQUESTS = [];
const upload = (path, name, body, contentType = MULTIPART) =>
  REQUESTS.push({ name: `${path} ${name}`, method: 'POST', path, contentType, body });
for (const path of ['/system/document-lab/analyze', '/system/document-lab/report.docx']) {
  upload(path, 'one file', form(file('acta.txt', 'hola')));
  upload(
    path,
    'project_id of the scope',
    form(file('acta.txt', 'hola'), field('project_id', 'PRJ-SECHURA')),
  );
  upload(path, 'empty project_id', form(field('project_id', ''), file('acta.txt', 'hola')));
  upload(path, 'another project_id', form(file('acta.txt', 'hola'), field('project_id', 'PRJ-B')));
  upload(path, 'another project_id without a file', form(field('project_id', 'PRJ-B')));
  upload(
    path,
    'project_id as a file',
    form(file('acta.txt', 'hola'), file('p.txt', 'PRJ-B', 'project_id')),
  );
  upload(
    path,
    'project_id twice, the last wins',
    form(field('project_id', 'PRJ-B'), field('project_id', 'PRJ-SECHURA'), file('a.txt', 'x')),
  );
  upload(path, 'project_id[]', form(field('project_id[]', 'PRJ-B'), file('a.txt', 'x')));
  upload(path, 'no file', form(field('x', 'y')));
  upload(path, 'file as text', form(field('file', 'texto')));
  upload(path, 'the last file wins', form(file('a.txt', 'uno'), file('b.md', 'dos')));
  upload(path, 'an empty file name', form(file('', 'sin nombre')));
  upload(path, 'not a form', '{"file":"x"}', 'application/json');
  upload(path, 'no content type', form(file('a.txt', 'x')), null);
  upload(path, 'an invalid multipart body', `--${BOUNDARY}\r\nbroken`);
  upload(path, 'no boundary', form(file('a.txt', 'x')), 'multipart/form-data');
  upload(path, 'urlencoded', 'file=x&project_id=PRJ-B', 'application/x-www-form-urlencoded');
  upload(path, 'at the size limit', form(file('a.txt', 'x'.repeat(MAX + 64 * 1024 - 200))));
  upload(path, 'over the size limit', form(file('a.txt', 'x'.repeat(MAX + 64 * 1024))));
  for (const kind of ['extension', 'too_large', 'empty', 'too_many_pages', 'unreadable', 'no_text'])
    upload(path, `service error ${kind}`, form(file(`err-${kind}.txt`, 'x')));
}
const compare = '/system/document-lab/compare';
upload(compare, 'two files', form(file('a.txt', 'uno', 'file_a'), file('b.txt', 'dos', 'file_b')));
upload(
  compare,
  'file_b first',
  form(file('b.txt', 'dos', 'file_b'), file('a.txt', 'uno', 'file_a')),
);
upload(compare, 'only file_a', form(file('a.txt', 'uno', 'file_a')));
upload(compare, 'only file_b', form(file('b.txt', 'dos', 'file_b')));
upload(compare, 'neither', form(field('file', 'x')));
upload(
  compare,
  'another project_id',
  form(file('a.txt', 'uno', 'file_a'), field('project_id', 'PRJ-B')),
);
upload(
  compare,
  'over the size limit',
  form(file('a.txt', 'x'.repeat(2 * MAX + 64 * 1024), 'file_a'), file('b.txt', 'y', 'file_b')),
);
upload(
  compare,
  'within the two-file limit',
  form(file('a.txt', 'x'.repeat(MAX + 64 * 1024), 'file_a'), file('b.txt', 'y', 'file_b')),
);
for (const kind of ['extension', 'too_large', 'empty', 'too_many_pages', 'unreadable', 'no_text'])
  upload(
    compare,
    `service error ${kind}`,
    form(file('a.txt', 'x', 'file_a'), file(`err-${kind}.txt`, 'y', 'file_b')),
  );

const json = (method, path, name, body, contentType = 'application/json', headers = {}) =>
  REQUESTS.push({ name: `${method} ${path} ${name}`, method, path, contentType, body, headers });
const IMPORT = '/system/document-lab/review/import';
const SHA = 'ab'.repeat(32);
const item = (extra = {}) => ({
  tema: 'Tema',
  fragmento: 'Fragmento',
  ubicacion: 'Página 1',
  accion_sugerida: 'Acción',
  ...extra,
});
const importBodies = [
  ['a batch', { filename: 'acta.pdf', sha256: SHA, items: [item()] }],
  ['project_id', { project_id: 'PRJ-SECHURA', filename: 'a', sha256: SHA, items: [] }],
  ['empty project_id', { project_id: '', filename: 'a', sha256: SHA, items: [] }],
  ['unknown keys are dropped', { filename: 'a', sha256: SHA, items: [], extra: 1 }],
  [
    'item values of every JSON type',
    {
      filename: 'a',
      sha256: SHA,
      items: [
        item({ tema: 7, fragmento: 1.5e-7, ubicacion: true, accion_sugerida: null }),
        item({
          tema: { b: 1, a: [1, 'x', null] },
          fragmento: [1, 2],
          ubicacion: -0,
          accion_sugerida: 1e21,
        }),
        { fragmento: 'solo fragmento' },
        item({ __proto__: 'x', extra: 'y' }),
        {},
      ],
    },
  ],
  ['not JSON', '{"filename":'],
  ['empty body', ''],
  ['a byte order mark', '\ufeff{"filename":"a","sha256":"x","items":[]}'],
  ['an array', []],
  ['null', null],
  ['a string', 'texto'],
  ['nothing', {}],
  ['wrong types', { project_id: 1, filename: null, sha256: false, items: {} }],
  [
    'items of wrong types',
    { filename: 'a', sha256: SHA, items: [1, null, 'x', [], { a: 1 }, true] },
  ],
  ['missing items', { filename: 'a', sha256: SHA }],
  ['missing filename only', { sha256: SHA, items: [] }],
  ['constructor key', { filename: 'a', sha256: SHA, items: [], constructor: 1 }],
  ['service error sha256', { filename: 'err-sha256', sha256: 'x', items: [] }],
  ['service error too_many', { filename: 'err-too_many', sha256: SHA, items: [] }],
  ['service error invalid_text', { filename: 'err-invalid_text', sha256: SHA, items: [] }],
  ['duplicate keys', '{"filename":"a","filename":"b","sha256":"' + SHA + '","items":[]}'],
  [
    'unicode escapes',
    '{"filename":"\\u00e9\\ud83d\\ude00","sha256":"' + SHA + '","items":[{"tema":"\\u0000"}]}',
  ],
];
for (const [name, body] of importBodies)
  json('POST', IMPORT, name, typeof body === 'string' ? body : JSON.stringify(body));
json(
  'POST',
  IMPORT,
  'text content type',
  JSON.stringify({ filename: 'a', sha256: SHA, items: [] }),
  'text/plain',
);

const decisionBodies = [
  ['a decision', { status: 'aceptado_para_revision', reviewer: 'Equipo', note: 'Nota' }],
  ['defaults', { status: 'descartado' }],
  ['missing status', { reviewer: 'x' }],
  ['wrong types', { status: 1, reviewer: null, note: [] }],
  ['null reviewer', { status: 'x', reviewer: null }],
  ['an array', ['x']],
  ['not JSON', '{'],
  ['unknown keys', { status: 'pendiente', other: true }],
];
for (const [name, body] of decisionBodies) {
  json(
    'PATCH',
    '/system/document-lab/review/item-1',
    name,
    typeof body === 'string' ? body : JSON.stringify(body),
  );
}
for (const id of [
  'err-status',
  'err-note_required',
  'err-missing',
  'err-invalid_text',
  'id%20con%20espacio',
  'a%2Fb',
  '%E2%82',
  'bulk',
])
  json(
    'PATCH',
    `/system/document-lab/review/${id}`,
    `id ${id}`,
    JSON.stringify({ status: 'pendiente' }),
  );

const BULK = '/system/document-lab/review/bulk';
const bulkBodies = [
  ['ids', { ids: ['a', 'b'], status: 'aceptado_para_revision' }],
  ['theme', { theme: 'Tema', status: 'descartado', note: 'n', dry_run: true }],
  ['source', { source_sha256: SHA, status: 'corroborado_documentalmente', note: 'n' }],
  ['theme and source', { theme: 'T', source_sha256: SHA, status: 'descartado' }],
  ['ids and theme', { ids: ['a'], theme: 'T', status: 'descartado' }],
  ['neither', { status: 'descartado' }],
  ['unknown key', { ids: ['a'], status: 'descartado', extra: 1 }],
  ['unknown keys', { zeta: 1, ids: ['a'], alfa: 2, status: 'descartado' }],
  ['unknown key and a bad status', { ids: ['a'], status: 'pendiente', extra: 1 }],
  ['bad status', { ids: ['a'], status: 'pendiente' }],
  ['missing status', { ids: ['a'] }],
  ['status of a wrong type', { ids: ['a'], status: 1 }],
  ['empty ids', { ids: [], status: 'descartado' }],
  [
    'too many ids',
    [
      ['{"ids":[', 1],
      ['"a",', 5000],
      ['"a"],"status":"descartado"}', 1],
    ],
  ],
  ['long id', { ids: ['x'.repeat(65)], status: 'descartado' }],
  ['id of 64 with an emoji', { ids: ['x'.repeat(62) + '😀'], status: 'descartado' }],
  ['id of 65 with an emoji', { ids: ['x'.repeat(63) + '😀'], status: 'descartado' }],
  ['ids of wrong types', { ids: ['a', 1, null], status: 'descartado' }],
  ['ids not an array', { ids: 'a', status: 'descartado' }],
  ['long theme', { theme: 't'.repeat(141), status: 'descartado' }],
  ['bad sha', { source_sha256: 'AB'.repeat(32), status: 'descartado' }],
  ['sha of wrong type', { source_sha256: 1, status: 'descartado' }],
  ['long note', { ids: ['a'], status: 'descartado', note: 'n'.repeat(1501) }],
  ['note null', { ids: ['a'], status: 'descartado', note: null }],
  ['dry_run not boolean', { ids: ['a'], status: 'descartado', dry_run: 'true' }],
  [
    'many problems',
    { ids: [], theme: 1, source_sha256: 'x', status: 'x', note: 2, dry_run: 0, extra: 1 },
  ],
  ['an array', [1]],
  ['null', null],
  ['not JSON', 'x'],
  ['service error status', { ids: ['a'], status: 'descartado', note: 'err-status' }],
  ['service error note_required', { ids: ['a'], status: 'descartado', note: 'err-note_required' }],
  ['service error too_many', { ids: ['a'], status: 'descartado', note: 'err-too_many' }],
  ['service error invalid_text', { ids: ['a'], status: 'descartado', note: 'err-invalid_text' }],
  ['service error missing', { ids: ['a'], status: 'descartado', note: 'err-missing' }],
  ['duplicate ids pass through', { ids: ['a', 'a'], status: 'descartado' }],
  ['null theme', { theme: null, status: 'descartado' }],
  ['empty ids and a theme', { ids: [], theme: 'T', status: 'descartado' }],
  ['a long id and a theme', { ids: ['x'.repeat(65)], theme: 'T', status: 'descartado' }],
  ['a long theme with ids', { ids: ['a'], theme: 't'.repeat(141), status: 'descartado' }],
  ['a bad sha with ids', { ids: ['a'], source_sha256: 'x', status: 'descartado' }],
  [
    'a long note with ids and a theme',
    { ids: ['a'], theme: 'T', status: 'descartado', note: 'n'.repeat(1501) },
  ],
  [
    'an unknown key with ids and a theme',
    { ids: ['a'], theme: 'T', status: 'descartado', extra: 1 },
  ],
  ['a bad status with ids and a theme', { ids: ['a'], theme: 'T', status: 'x' }],
  ['a long note and nothing to select', { status: 'descartado', note: 'n'.repeat(1501) }],
  ['an unknown key and nothing to select', { status: 'descartado', extra: 1 }],
  ['a long theme only', { theme: 't'.repeat(141), status: 'descartado' }],
  ['__proto__ key', '{"ids":["a"],"status":"descartado","__proto__":1}'],
  ['constructor key', { ids: ['a'], status: 'descartado', constructor: 1 }],
  [
    'too many ids and a long one',
    [
      ['{"ids":["', 1],
      ['x', 65],
      ['",', 1],
      ['"a",', 4999],
      ['"a"],"status":"descartado"}', 1],
    ],
  ],
  [
    'too many ids and a number',
    [
      ['{"ids":[1,', 1],
      ['"a",', 4999],
      ['"a"],"status":"descartado"}', 1],
    ],
  ],
  ['dry_run null', { ids: ['a'], status: 'descartado', dry_run: null }],
  [
    'too many ids and a theme',
    [
      ['{"ids":[', 1],
      ['"a",', 5000],
      ['"a"],"theme":"T","status":"descartado"}', 1],
    ],
  ],
  ['empty ids of nothing else', { ids: [], status: 'x' }],
];
for (const [name, body] of bulkBodies)
  json(
    'POST',
    BULK,
    name,
    typeof body === 'string' || (Array.isArray(body) && Array.isArray(body[0]))
      ? body
      : JSON.stringify(body),
  );
json(
  'POST',
  BULK,
  'empty full name',
  JSON.stringify({ ids: ['a'], status: 'descartado' }),
  'application/json',
  { 'x-test-full-name': '' },
);

/** A body as [text, times] segments; runs of 64 or more equal characters are folded. */
const segments = (body) => {
  if (Array.isArray(body)) return body;
  const out = [];
  let text = '';
  for (let i = 0; i < body.length;) {
    let j = i;
    while (j < body.length && body[j] === body[i]) j++;
    if (j - i >= 64) {
      if (text) out.push([text, 1]);
      out.push([body[i], j - i]);
      text = '';
    } else text += body.slice(i, j);
    i = j;
  }
  if (text) out.push([text, 1]);
  return out;
};
const joined = (segs) => segs.map(([text, times]) => text.repeat(times)).join('');

const http = [];
for (const r of REQUESTS) {
  calls.length = 0;
  const headers = { ...(r.headers ?? {}) };
  if (r.contentType) headers['content-type'] = r.contentType;
  const body = segments(r.body);
  const res = await app.request(r.path, { method: r.method, headers, body: joined(body) });
  const type = res.headers.get('content-type') ?? '';
  const text = await res.text();
  http.push({
    name: r.name,
    method: r.method,
    path: r.path,
    content_type: r.contentType,
    headers: r.headers ?? {},
    body,
    status: res.status,
    response_type: type,
    response: type.includes('json') ? JSON.parse(text) : text,
    disposition: res.headers.get('content-disposition'),
    calls: structuredClone(calls),
  });
}

// ---- imports: the real service behind the real route, with a store that records rows ------

const imported = [];
let hex = 0;
const importLab = createDocumentLabService({
  reader: inlineDocumentReader,
  renderer: docxRenderer,
  reviews: {
    async importItems(tenantId, rows) {
      imported.push({
        tenantId,
        rows: rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })),
      });
      return rows.length;
    },
  },
  records: {},
  clock: { now: () => NOW },
  randomHex: (length) => (hex++).toString(16).toUpperCase().padStart(length, '0'),
  maxUploadBytes: MAX,
});
const importApp = new Hono();
importApp.use('*', async (c, next) => {
  c.set('scope', { companyId: 'SIPGES', projectId: 'PRJ-SECHURA' });
  await next();
});
importApp.route('/', documentLabRoutes(importLab));
const longText = (n) => 'á'.repeat(n - 1) + '😀😀';
const IMPORTS = [
  { filename: 'acta.pdf', sha256: SHA, items: [item()] },
  {
    project_id: 'PRJ-SECHURA',
    filename: 'f'.repeat(199) + '😀😀',
    sha256: SHA,
    items: [
      item({
        tema: longText(140),
        fragmento: longText(480),
        ubicacion: longText(140),
        accion_sugerida: longText(500),
      }),
    ],
  },
  {
    filename: 'tipos',
    sha256: SHA,
    items: [
      item({ tema: 7, fragmento: 1.5e-7, ubicacion: true, accion_sugerida: null }),
      item({
        tema: { b: 1, a: [1, 'x', null, { __proto__: 1 }] },
        fragmento: [1, 2.5, -0],
        ubicacion: -0,
        accion_sugerida: 1e21,
      }),
      item({ tema: false, fragmento: 1e-7, ubicacion: 123456789012345680000, accion_sugerida: {} }),
      { fragmento: 'solo fragmento' },
      { ubicacion: 'solo ubicación' },
      { fragmento: '', ubicacion: 'x' },
      item({ extra: 'y' }),
      {},
    ],
  },
  { filename: 'nul', sha256: SHA, items: [item({ accion_sugerida: 'a b' })] },
  { filename: 'nul omitido', sha256: SHA, items: [{ tema: ' ', ubicacion: '', fragmento: 'x' }] },
  { filename: 'vacío', sha256: SHA, items: [{}, { tema: 'x' }] },
  { filename: 'sha', sha256: SHA.toUpperCase(), items: [item()] },
  { filename: 'muchos', sha256: SHA, items: Array.from({ length: 76 }, () => ({})) },
  {
    filename: 'setenta y cinco',
    sha256: SHA,
    items: Array.from({ length: 75 }, (_, i) => item({ fragmento: `F${i}` })),
  },
];
const imports = [];
for (const body of IMPORTS) {
  imported.length = 0;
  hex = 0;
  const res = await importApp.request('/system/document-lab/review/import', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  imports.push({
    body: JSON.stringify(body),
    status: res.status,
    response: await res.json(),
    rows: structuredClone(imported),
  });
}

const fixtures = {
  node: process.version,
  now: NOW.toISOString(),
  docx: await Promise.all(
    DOCX.map(async ([name, bytes]) => ({ name, data: b64(bytes), ...(await readDocx(bytes)) })),
  ),
  analyses,
  comparisons,
  report_parts: reportParts,
  reports,
  records,
  max_upload_bytes: MAX,
  http,
  imports,
};
const text = await format(JSON.stringify(fixtures), {
  ...(await resolveConfig(OUT)),
  parser: 'json',
});
if (process.argv.includes('--check')) {
  const current = readFileSync(OUT, 'utf8');
  if (current !== text) {
    console.error('fixtures.json drifted: rerun without --check');
    process.exit(1);
  }
} else {
  writeFileSync(OUT, text);
}
