// Rewrites pdfjs.bundle.js from the published unpdf package: the serverless pdf.js build the
// TypeScript API runs, as a plain script for QuickJS. The tarball's hash is the lockfile's.
//
//   node engines/crates/pdf-text-wasm/js/vendor.mjs
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

const url = 'https://registry.npmjs.org/unpdf/-/unpdf-2.1.0.tgz';
const integrity = 'G/Hsrm++g0EoubUhV8TDFItq6oQ+FUu9EMvIRtHUwseKXB0iJoCvaLvBGOpYUBqyvggv/XfxhYYtohL2QpE3xQ==';
const member = 'package/dist/pdfjs.mjs';

const tgz = Buffer.from(await (await fetch(url)).arrayBuffer());
if (createHash('sha512').update(tgz).digest('base64') !== integrity) {
  throw new Error('the unpdf tarball does not match its lockfile hash');
}
const tar = gunzipSync(tgz);
let source = null;
for (let at = 0; at + 512 <= tar.length && tar[at] !== 0; ) {
  const name = tar.toString('utf8', at, at + 100).replace(/\0.*$/s, '');
  const size = Number.parseInt(tar.toString('utf8', at + 124, at + 136).trim(), 8);
  if (name === member) source = tar.toString('utf8', at + 512, at + 512 + size);
  at += 512 + Math.ceil(size / 512) * 512;
}
if (source === null) throw new Error(`${member} is missing`);

// A script cannot read import.meta or export; only the fake worker's unused paths use the first.
const exports = source.lastIndexOf('export{');
if (exports < 0) throw new Error('the bundle has no export list');
const script = `${source
  .slice(0, exports)
  .replaceAll('import.meta.url', "'file:///pdfjs.js'")}globalThis.__pdfjs={getDocument};\n`;
writeFileSync(new URL('./pdfjs.bundle.js', import.meta.url), script);
