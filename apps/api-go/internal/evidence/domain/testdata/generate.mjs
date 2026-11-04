// Records the TypeScript evidence upload policy (apps/api/src/contexts/evidence/domain) on
// synthetic inputs, for the Go port's test (../upload_policy_test.go). Run from the repository
// root after changing either side:
//
//   node apps/api-go/internal/evidence/domain/testdata/generate.mjs          # rewrites the fixture
//   node apps/api-go/internal/evidence/domain/testdata/generate.mjs --check  # exit 1 when it drifted
//
// Every input is synthetic: file names and byte strings written here, no real file.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { format, resolveConfig } from 'prettier';
import {
  ALLOWED_EXTENSIONS,
  checkUpload,
  extensionOf,
  safeUploadName,
} from '../../../../../api/src/contexts/evidence/domain/index.ts';

const OUT = fileURLToPath(new URL('./upload-policy.json', import.meta.url));

const NAMES = [
  '',
  'archivo',
  'acta.pdf',
  'ACTA.PDF',
  '.pdf',
  '.hidden',
  'a.',
  'a..pdf',
  'informe final 2026.docx',
  'C:\\Users\\x\\Escritorio\\reporte.xlsx',
  '../../etc/passwd',
  '/tmp/../foto.JPG',
  'dir/sub\\nombre con espacios.txt',
  'Señalización vía pública.csv',
  'ÁÉÍÓÚ ñ ü.jpeg',
  'ﬁcha técnica.png',
  '①②③.webp',
  '😀 emoji 😀.pdf',
  '---___...nombre...___---.doc',
  '___.pdf',
  'a'.repeat(100) + '.pdf',
  'é'.repeat(90) + '.xls',
  'tab\there.pdf',
  'nul\u0000.pdf',
  'ẞ straße.txt',
  'İstanbul.csv',
  'mapa.geojson',
  'virus.exe',
  'page.html',
  'archivo.PdF',
  'x.tar.gz',
  '名前.pdf',
  'نص عربي.txt',
  'a\u0301\u0327.pdf',
  'Ω≈ç√∫.pdf',
  '   espacios   .pdf',
  'trailing/',
  'only\\',
  '..',
  '.',
];

const bytes = (...parts) => {
  const out = [];
  for (const part of parts) {
    if (typeof part === 'string') out.push(...new TextEncoder().encode(part));
    else out.push(...part);
  }
  return Uint8Array.from(out);
};

const ZIP = [0x50, 0x4b, 0x03, 0x04];
const OLE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const BODIES = {
  empty: bytes(),
  pdf: bytes('%PDF-1.7\n%synthetic'),
  pdf_short: bytes('%PDF'),
  zip: bytes(ZIP, 'synthetic'),
  ole: bytes(OLE, 'synthetic'),
  jpeg: bytes([0xff, 0xd8, 0xff, 0xe0], 'synthetic'),
  png: bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'synthetic'),
  webp: bytes('RIFF', [0, 0, 0, 0], 'WEBPVP8 '),
  riff_only: bytes('RIFF', [0, 0, 0, 0], 'WAVE'),
  text: bytes('Fecha,Tema\n2026-01-01,Agua\r\n\tcon tab\f'),
  text_bom: bytes([0xef, 0xbb, 0xbf], 'título'),
  text_nul: bytes('a\u0000b'),
  text_del: bytes('a\u007fb'),
  text_vt: bytes('a\u000bb'),
  text_esc: bytes('a\u001bb'),
  text_c1: bytes('a\u0085b'),
  text_bad_utf8: bytes('a', [0xc3, 0x28]),
  text_overlong: bytes([0xc0, 0xaf]),
  text_surrogate: bytes([0xed, 0xa0, 0x80]),
  text_truncated: bytes('ok', [0xe2, 0x82]),
  html: bytes('<!doctype html><script>x</script>'),
  exe: bytes('MZ\u0090\u0000'),
  big: bytes('%PDF-', 'x'.repeat(40)),
};

const MAX_BYTES = 32;

const checks = [];
for (const name of NAMES) {
  for (const [body, value] of Object.entries(BODIES)) {
    const result = checkUpload(name, value, MAX_BYTES);
    checks.push({
      name,
      body,
      result: result.ok ? { ok: true, ...result.value } : { ok: false, kind: result.error.kind },
    });
  }
}

const fixture = {
  allowed: ALLOWED_EXTENSIONS,
  max_bytes: MAX_BYTES,
  bodies: Object.fromEntries(Object.entries(BODIES).map(([k, v]) => [k, [...v]])),
  extensions: NAMES.map((name) => ({ name, extension: extensionOf(name) })),
  safe_names: NAMES.map((name) => ({ name, safe: safeUploadName(name) })),
  checks,
};

// Formatted as `pnpm lint` (prettier --check) expects.
const text = await format(JSON.stringify(fixture), {
  ...(await resolveConfig(OUT)),
  filepath: OUT,
});
if (process.argv.includes('--check')) {
  if (readFileSync(OUT, 'utf8') !== text) {
    console.error(`${OUT} drifted from the TypeScript upload policy; rerun without --check`);
    process.exit(1);
  }
} else {
  writeFileSync(OUT, text);
}
