// Records the TypeScript evidence rules that the Go file routes reuse, on synthetic inputs, for
// ../files_test.go: projectOf and linkIntoPayload (attachment.ts, after JSON.parse and
// JSON.stringify as the store runs them), the viewer's text of .txt/.csv objects (preview of
// evidence-service.ts with in-memory ports) and the UTF-8 decoding of TextDecoder. Run from the
// repository root after changing either side:
//
//   node apps/api-go/internal/evidence/domain/testdata/generate-files.mjs          # rewrites files.json
//   node apps/api-go/internal/evidence/domain/testdata/generate-files.mjs --check  # exit 1 when it drifted
//
// Every input is synthetic, written here.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { format, resolveConfig } from 'prettier';
import { createEvidenceService } from '../../../../../api/src/contexts/evidence/application/index.ts';
import {
  linkIntoPayload,
  projectOf,
} from '../../../../../api/src/contexts/evidence/domain/index.ts';

const OUT = fileURLToPath(new URL('./files.json', import.meta.url));

const PAYLOADS = [
  '{}',
  '{"Proyecto_ID":"PRJ-SECHURA"}',
  '{"Proyecto_ID":"PRJ-SECHURA","Proyecto":"Nombre propio"}',
  '{"Proyecto_ID":"OTRO","Proyecto":""}',
  '{"Proyecto_ID":"","Proyecto":"Solo nombre"}',
  '{"Proyecto_ID":0,"Proyecto":0}',
  '{"Proyecto_ID":-0.0,"Proyecto":false}',
  '{"Proyecto_ID":7,"Proyecto":1.5e-7}',
  '{"Proyecto_ID":1e21,"Proyecto":123456789012345678901234567890}',
  '{"Proyecto_ID":1e400,"Proyecto":-1e400}',
  '{"Proyecto_ID":true,"Proyecto":null}',
  '{"Proyecto_ID":{"a":1},"Proyecto":[1,null,"x",[2,3],{"b":1}]}',
  '{"Proyecto_ID":[],"Proyecto":[null]}',
  '{"Proyecto_ID":"  ","Proyecto":"ñ😀"}',
  '{"Adjuntos":[{"id":"OLD","archivo":"a.pdf"}],"Titulo":"x","n":0.1}',
  '{"Adjuntos":"texto","Evidencia/Resultado":"previo","Archivo_Fuente":"previo"}',
  '{"Adjuntos":null,"Monto":12345678901234567890,"Cero":-0,"Lista":[1e400,2.50,1E+2]}',
  '{"Adjuntos":{"0":"x"},"__proto__":{"y":1},"constructor":"c"}',
];
const SLUGS = ['eventos', 'fuentes', 'alertas'];
const LINK = {
  id: 'ADJ-0123456789AB',
  fileName: 'acta.pdf',
  documentType: 'Acta <b>',
  verification: 'A - Verificada',
};

const payloads = [];
for (const text of PAYLOADS) {
  for (const scope of ['SUBIDAS', 'PRJ-SECHURA']) {
    const payload = JSON.parse(text);
    payloads.push({
      payload: text,
      scope,
      project: projectOf(payload, scope),
      links: Object.fromEntries(
        SLUGS.map((slug) => [slug, JSON.stringify(linkIntoPayload(payload, slug, LINK))]),
      ),
    });
  }
}

/**
 * Synthetic objects for the viewer: `a` repeated `count` times, then the `tail` bytes (so the
 * fixture stays small while crossing the 200,000-unit limit).
 */
const utf8 = (s) => [...Buffer.from(s, 'utf8')];
const TEXTS = {
  plain: { count: 0, tail: utf8('hola\nmundo') },
  bom: { count: 0, tail: [0xef, 0xbb, 0xbf, ...utf8('hola')] },
  two_boms: { count: 0, tail: [0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf, ...utf8('hola')] },
  three_boms: {
    count: 0,
    tail: [0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf, ...utf8('hola')],
  },
  blank: { count: 0, tail: utf8(' \t\n\u00a0\u3000\ufeff\u2028') },
  nel_is_text: { count: 0, tail: utf8('\u0085') },
  empty: { count: 0, tail: [] },
  invalid: {
    count: 0,
    tail: [
      0x61, 0xe2, 0x82, 0x62, 0xff, 0xc0, 0xaf, 0xed, 0xa0, 0x80, 0xf0, 0x9f, 0x98, 0xf4, 0x90,
      0x80, 0x80, 0xe0, 0x80, 0xaf, 0xc2,
    ],
  },
  exactly_the_limit: { count: 200_000, tail: [] },
  one_over: { count: 200_001, tail: [] },
  cut_in_a_pair: { count: 199_999, tail: utf8('😀b') },
  pair_at_the_end: { count: 199_998, tail: utf8('😀') },
};
const bytesOf = ({ count, tail }) => new Uint8Array([...Buffer.alloc(count, 'a'), ...tail]);
const units = (s) => {
  const out = [];
  for (let i = 0; i < s.length; i++) out.push(s.charCodeAt(i));
  return out;
};
/** A page as its UTF-16 length and its last eight code units (a lone surrogate shows there). */
const page = (p) => ({ length: p.length, tail: units(p.slice(-8)) });

const attachment = (name) => ({
  id: 'ADJ-X',
  storageKey: `${'a'.repeat(24)}/x_${name}`,
  originalName: name,
  contentType: 'text/plain',
  sizeBytes: 1,
  sha256: 'a'.repeat(64),
  linkedModule: 'eventos',
  linkedRecordId: 'EV-1',
  documentType: 'd',
  author: '',
  verification: 'v',
  notes: '',
  projectId: 'P',
  projectName: '',
  createdAt: new Date(0),
});

const previews = {};
for (const [name, spec] of Object.entries(TEXTS)) {
  const service = createEvidenceService({
    storage: { put: async () => {}, get: async () => bytesOf(spec), delete: async () => {} },
    store: { attach: async () => null, list: async () => [], get: async () => attachment('x.txt') },
    clock: { now: () => new Date(0) },
    randomHex: () => '0',
    maxUploadBytes: 1,
    text: { pdf: async () => [], docx: async () => [] },
  });
  const result = await service.preview('T/P', 'ADJ-X');
  previews[name] = {
    ...spec,
    result:
      result.kind === 'text'
        ? { kind: 'text', truncated: result.truncated, pages: result.pages.map(page) }
        : { kind: result.kind },
  };
}

const decodes = Object.fromEntries(
  Object.entries(TEXTS)
    .filter(([, spec]) => spec.count === 0)
    .map(([name, spec]) => [
      name,
      {
        bytes: spec.tail,
        strip: units(new TextDecoder('utf-8').decode(bytesOf(spec))),
        keep: units(new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytesOf(spec))),
      },
    ]),
);

const text = await format(JSON.stringify({ payloads, previews, decodes }), {
  ...(await resolveConfig(OUT)),
  filepath: OUT,
});
if (process.argv.includes('--check')) {
  if (readFileSync(OUT, 'utf8') !== text) {
    console.error(`${OUT} drifted from the TypeScript evidence rules; rerun without --check`);
    process.exit(1);
  }
} else {
  writeFileSync(OUT, text);
}
