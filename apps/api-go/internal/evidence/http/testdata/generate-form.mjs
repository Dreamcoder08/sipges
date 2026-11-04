// Records how the TypeScript upload route reads its body (`c.req.parseBody()` of Hono over the
// undici that Node bundles) on synthetic requests, for the Go port's test (../form_test.go).
// Run from the repository root with the Node version CI uses (22) after upgrading Hono or Node:
//
//   node apps/api-go/internal/evidence/http/testdata/generate-form.mjs          # rewrites form.json
//   node apps/api-go/internal/evidence/http/testdata/generate-form.mjs --check  # exit 1 when it drifted
//
// Every body is synthetic, written here.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { format, resolveConfig } from 'prettier';
import { Hono } from '../../../../../api/node_modules/hono/dist/index.js';

const OUT = fileURLToPath(new URL('./form.json', import.meta.url));
const B = 'sipgesBoundary0123456789abcdefXYZ';
const MP = `multipart/form-data; boundary=${B}`;

// Header strings are written byte for byte (latin1); a Buffer header keeps its bytes.
const part = (headers, body) => [
  Buffer.from(`--${B}\r\n`),
  Buffer.isBuffer(headers) ? headers : Buffer.from(headers, 'latin1'),
  Buffer.from('\r\n\r\n'),
  typeof body === 'string' ? Buffer.from(body) : Buffer.from(body),
  Buffer.from('\r\n'),
];
const multipart = (...parts) =>
  Buffer.concat([...parts.flatMap(([h, b]) => part(h, b)), Buffer.from(`--${B}--\r\n`)]);
const cd = (name, extra = '') => `Content-Disposition: form-data; name="${name}"${extra}`;
const file = (filename, body = 'hola', name = 'file') => [cd(name, `; filename="${filename}"`), body];
const field = (name, value) => [cd(name), value];
const utf8 = (s) => Buffer.from(s, 'utf8');
const latin1 = (s) => Buffer.from(s, 'latin1');

/** [name, Content-Type header (latin1 bytes) or null, body bytes] */
const CASES = [
  ['no content type', null, utf8('file=x')],
  ['json content type', 'application/json', utf8('{"file":"x"}')],
  ['text/plain', 'text/plain', utf8('file=x')],
  ['upload', MP, multipart(file('acta.pdf', '%PDF-1.7'), field('linked_module', 'eventos'), field('linked_record_id', 'EV-1'))],
  ['upper-case media type', `Multipart/Form-Data; boundary=${B}`, multipart(file('a.txt'))],
  ['quoted boundary', `multipart/form-data; boundary="${B}"`, multipart(file('a.txt'))],
  ['boundary with spaces around', `multipart/form-data ;  boundary=${B}  `, multipart(file('a.txt'))],
  ['upper-case parameter name', `multipart/form-data; BOUNDARY=${B}`, multipart(file('a.txt'))],
  ['repeated boundary: first wins', `multipart/form-data; boundary=${B}; boundary=x`, multipart(file('a.txt'))],
  ['no boundary', 'multipart/form-data', multipart(file('a.txt'))],
  ['empty boundary', 'multipart/form-data; boundary=', multipart(file('a.txt'))],
  ['empty quoted boundary', 'multipart/form-data; boundary=""', utf8('----\r\n')],
  ['wrong boundary', 'multipart/form-data; boundary=other', multipart(file('a.txt'))],
  ['two media types: the last wins', `text/plain, multipart/form-data; boundary=${B}`, multipart(file('a.txt'))],
  ['two media types: multipart then text', `multipart/form-data; boundary=${B}, text/plain`, multipart(file('a.txt'))],
  ['comma inside a quoted boundary', `multipart/form-data; boundary="a,b"`, utf8('--a,b--')],
  ['wildcard type ignored', `multipart/form-data; boundary=${B}, */*`, multipart(file('a.txt'))],
  ['leading nbsp in the media type', `\xa0multipart/form-data; boundary=${B}`, multipart(file('a.txt'))],
  ['latin-1 boundary', 'multipart/form-data; boundary=\xf1', utf8('--ñ--')],
  ['missing final boundary', MP, Buffer.from(`--${B}\r\n${cd('a')}\r\n\r\nx\r\n`)],
  ['preamble before the first boundary', MP, Buffer.concat([utf8('junk\r\n'), multipart(field('a', 'x'))])],
  ['leading and trailing CRLFs', MP, Buffer.concat([utf8('\r\n\r\n'), multipart(field('a', 'x')), utf8('\r\n\r\n')])],
  ['final boundary without CRLF', MP, utf8(`--${B}\r\n${cd('a')}\r\n\r\nx\r\n--${B}--`)],
  ['only the final boundary', MP, utf8(`--${B}--`)],
  ['empty body', MP, Buffer.alloc(0)],
  ['empty filename', MP, multipart(file(''))],
  ['filename with a path', MP, multipart(file('C:\\\\dir\\\\a.txt'))],
  ['filename with percent escapes', MP, multipart(file('%22a%0Ab%0dc%0a%22.txt'))],
  ['filename with %22 lower-case', MP, multipart(file('%2a%22.txt'))],
  ['filename with UTF-16 units as bytes', MP, multipart(file('ñandú 😀.txt'))],
  ['filename with UTF-8', MP, multipart([utf8(`${cd('file')}; filename="ñandú 😀.txt"`), 'x'])],
  ['filename with invalid UTF-8', MP, multipart([Buffer.concat([latin1(`${cd('file')}; filename="a`), Buffer.from([0xe2, 0x82]), latin1('.txt"')]).toString('latin1'), 'x'])],
  ['filename with a BOM', MP, multipart([`${cd('file')}; filename="\xef\xbb\xbfa.txt"`, 'x'])],
  ['filename* form', MP, multipart([`${cd('file')}; filename*="UTF-8''%C3%B1.txt"`, 'x'])],
  ['unquoted filename', MP, multipart([`${cd('file')}; filename=a.txt`, 'x'])],
  ['filename with an escaped quote', MP, multipart([`${cd('file')}; filename="a\\"b.txt"`, 'x'])],
  ['filename with a semicolon', MP, multipart(file('a;b.txt'))],
  ['unquoted name', MP, multipart(['Content-Disposition: form-data; name=a', 'x'])],
  ['lower-case header name', MP, multipart(['content-disposition: form-data; name="a"', 'x'])],
  ['header name with spaces', MP, multipart(['  Content-Disposition  : form-data; name="a"', 'x'])],
  ['attachment disposition', MP, multipart(['Content-Disposition: attachment; name="a"', 'x'])],
  ['no disposition', MP, multipart(['Content-Type: text/plain', 'x'])],
  ['two dispositions: the last wins', MP, multipart([`${cd('a')}\r\n${cd('b', '; filename="f.txt"')}`, 'x'])],
  ['disposition then a second without filename', MP, multipart([`${cd('a', '; filename="f.txt"')}\r\n${cd('b')}`, 'x'])],
  ['part content type kept out', MP, multipart([`${cd('file', '; filename="a.txt"')}\r\nContent-Type: text/html; charset=latin1`, 'x'])],
  ['unknown header', MP, multipart([`${cd('a')}\r\nX-Other: 1`, 'x'])],
  ['non-token header name', MP, multipart([`${cd('a')}\r\nX(Other): 1`, 'x'])],
  ['header line ending in LF only', MP, utf8(`--${B}\r\n${cd('a')}\nX: 1\r\n\r\nx\r\n--${B}--\r\n`)],
  ['header line ending in CR only', MP, utf8(`--${B}\r\n${cd('a')}\rX: 1\r\n\r\nx\r\n--${B}--\r\n`)],
  ['field with a filename is a file', MP, multipart([cd('linked_module', '; filename="x"'), 'fuentes'])],
  ['empty field', MP, multipart(field('notes', ''))],
  ['field with CRLF', MP, multipart(field('notes', 'a\r\nb'))],
  ['field with invalid UTF-8', MP, multipart(field('notes', Buffer.from([0x61, 0xe2, 0x82, 0x62, 0xff, 0xc0, 0xaf, 0xed, 0xa0, 0x80, 0xf0, 0x9f, 0x98])))],
  ['field with one BOM', MP, multipart(field('notes', Buffer.from([0xef, 0xbb, 0xbf, 0x61])))],
  ['field with two BOMs', MP, multipart(field('notes', Buffer.from([0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf, 0x61])))],
  ['field with three BOMs', MP, multipart(field('notes', Buffer.from([0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf, 0x61])))],
  ['name with a BOM and escapes', MP, multipart([`${cd('\xef\xbb\xbfa%0Db')}`, 'x'])],
  ['repeated field', MP, multipart(field('linked_module', 'a'), field('linked_module', 'b'))],
  ['file then text under one name', MP, multipart(file('a.txt'), field('file', 'x'))],
  ['array field', MP, multipart(field('tags[]', 'a'), field('tags[]', 'b'))],
  ['boundary string inside a value', MP, multipart(field('a', `x${B}y`))],
  ['dashes and boundary inside a value', MP, multipart(field('a', `x\r\n--${B}y`))],
  ['binary file', MP, multipart(file('a.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff])))],
  ['base64 file', MP, multipart([`${cd('file', '; filename="a.txt"')}\r\nContent-Transfer-Encoding: base64`, 'aG9sYQ=='])],
  ['base64 with junk and url-safe characters', MP, multipart([`${cd('file', '; filename="a.txt"')}\r\nContent-Transfer-Encoding: base64`, 'a G\n9s-_Y*Q'])],
  ['base64 with = in the middle', MP, multipart([`${cd('file', '; filename="a.txt"')}\r\nContent-Transfer-Encoding: base64`, 'aG9=sYQ'])],
  ['base64 field', MP, multipart([`${cd('notes')}\r\nContent-Transfer-Encoding: base64`, 'w7E='])],
  ['base64 upper-case is not base64', MP, multipart([`${cd('notes')}\r\nContent-Transfer-Encoding: BASE64`, 'w7E='])],
  ['base64 with trailing spaces', MP, multipart([`${cd('notes')}\r\nContent-Transfer-Encoding: base64  `, 'w7E='])],
  ['urlencoded', 'application/x-www-form-urlencoded', utf8('file=x&linked_module=%C3%B1&a=%ZZ&b=+&c=%E0%A4&&d&=e&f==g')],
  ['urlencoded with a leading ?', 'application/x-www-form-urlencoded', utf8('?a=1&b=2')],
  ['urlencoded with invalid UTF-8', 'application/x-www-form-urlencoded', Buffer.from([0x61, 0x3d, 0xff, 0x25, 0x46, 0x46])],
  ['urlencoded with a BOM', 'application/x-www-form-urlencoded', Buffer.from([0xef, 0xbb, 0xbf, 0x61, 0x3d, 0x25, 0x45, 0x46, 0x25, 0x42, 0x42, 0x25, 0x42, 0x46])],
  ['urlencoded charset parameter', 'application/x-www-form-urlencoded; charset=latin1', latin1('a=\xf1')],
  ['urlencoded with a trailing %', 'application/x-www-form-urlencoded', utf8('a=%&b=%4')],
];

const app = new Hono();
app.post('/', async (c) => {
  try {
    const body = await c.req.parseBody({ all: true });
    const out = {};
    for (const [key, value] of Object.entries(body)) {
      out[key] = [];
      for (const v of Array.isArray(value) ? value : [value]) {
        out[key].push(
          typeof v === 'string'
            ? { text: v }
            : { file: v.name, data: Buffer.from(await v.arrayBuffer()).toString('base64') },
        );
      }
    }
    return c.json({ ok: true, entries: out });
  } catch {
    return c.json({ ok: false });
  }
});

const cases = [];
for (const [name, contentType, body] of CASES) {
  const headers = new Headers();
  if (contentType !== null) headers.set('content-type', contentType);
  const response = await app.request('http://local/', { method: 'POST', headers, body });
  cases.push({
    name,
    content_type: contentType === null ? null : Buffer.from(contentType, 'latin1').toString('base64'),
    body: body.toString('base64'),
    result: await response.json(),
  });
}

const text = await format(JSON.stringify({ node: process.versions.node, cases }), {
  ...(await resolveConfig(OUT)),
  filepath: OUT,
});
if (process.argv.includes('--check')) {
  if (readFileSync(OUT, 'utf8') !== text) {
    console.error(`${OUT} drifted from Hono's parseBody; rerun without --check`);
    process.exit(1);
  }
} else {
  writeFileSync(OUT, text);
}
