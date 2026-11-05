// Records how the TypeScript API reads URLs, dates, feeds and the Defensoría's answers, for the
// Go port's tests (../domain/fixtures_test.go, ../infrastructure/gateways_test.go): `new URL`,
// `Date.parse`, parseFeed, matchedKeywords and feedUrlProblem of domain/feeds.ts, and the two
// gateways (rss-feed-gateway.ts, official-source.ts) over a fake fetch and resolver. Run from
// the repository root after changing either side:
//
//   node apps/api-go/internal/integration/testdata/domain.mjs          # rewrites the fixture
//   node apps/api-go/internal/integration/testdata/domain.mjs --check  # exit 1 when it drifted
//
// Every input is synthetic.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { format, resolveConfig } from 'prettier';
import {
  feedUrlProblem,
  matchedKeywords,
  parseFeed,
} from '../../../../api/src/contexts/integration/domain/feeds.ts';
import { createOfficialSourceGateway } from '../../../../api/src/contexts/integration/infrastructure/official-source.ts';
import { createRssFeedGateway } from '../../../../api/src/contexts/integration/infrastructure/rss-feed-gateway.ts';

const OUT = fileURLToPath(new URL('./domain.json', import.meta.url));
const FEED = readFileSync(fileURLToPath(new URL('./feed.xml', import.meta.url)), 'utf8');

const URLS = [
  'https://diario.example/rss',
  'HTTPS://Diario.EXAMPLE:443/a/../b/./c?q=1 2#f g',
  'https:diario.example',
  'https:\\\\diario.example\\a\\b',
  'https:///diario.example',
  'https://diario.example:0080/x',
  'https://diario.example:65536/x',
  'https://diario.example:/x',
  'https://u:p@diario.example/',
  'https://u@diario.example/',
  'https://:p@diario.example/',
  'https://@diario.example/',
  'https://a@b@diario.example/',
  'https://u:p:q@diario.example/',
  'https://diario.example/%zz/%41',
  'https://diario.example/ñ/😀?ñ=😀#ñ',
  "https://diario.example/a'b?c'd#e'f",
  'https://diario.example/{x}|y^z`?{x}|y^z`#{x}|y^z`',
  'https://diario.example/.%2E/%2e/x',
  'https://diario.example/a/b/..',
  'https://diario.example/a/b/.',
  'https://diario.example/..',
  'https://diario.example?',
  'https://diario.example#',
  'https://diario.example/?#',
  'https://127.0.0.1/',
  'https://127.1/',
  'https://0x7f.1/',
  'https://0177.0.0.1/',
  'https://2130706433/',
  'https://0x7f000001/',
  'https://4294967295/',
  'https://4294967296/',
  'https://1.2.3.4.5/',
  'https://1.2.3.256/',
  'https://256.1.1.1/',
  'https://1.2.3.4./',
  'https://1.2.3.09/',
  'https://0x/',
  'https://diario.0x10/',
  'https://diario.10/',
  'https://10.diario/',
  'https://[::1]/',
  'https://[::]/',
  'https://[0:0:0:0:0:0:0:1]/',
  'https://[::ffff:127.0.0.1]/',
  'https://[::FFFF:7F00:1]/',
  'https://[1:0:0:2:0:0:0:3]/',
  'https://[1:0:0:0:2:0:0:3]/',
  'https://[1::2::3]/',
  'https://[::1/',
  'https://[::1]x/',
  'https://[fe80::1%25eth0]/',
  'https://[1:2:3:4:5:6:7:8:9]/',
  'https://[1:2:3:4:5:6:1.2.3.4]/',
  'https://[1:2:3:4:5:6:7:1.2.3.4]/',
  'https://[::1.2.3]/',
  'https://[::01.2.3.4]/',
  'https://di%61rio.example/',
  'https://di%2Frio.example/',
  'https://di%25rio.example/',
  'https://dia rio.example/',
  'https://dia<rio.example/',
  'https://dia"rio.example/',
  'https://diario.example\u0000/',
  'https://di\u007frio.example/',
  'https://ñandú.example/',
  'https://xn--and-6ma2c.example/',
  '  \t https://diario.example/\n ',
  'https://dia\nrio.example/r\tss',
  'https://',
  'https:',
  'https://:443/',
  'http://diario.example',
  'ftp://diario.example/x',
  'ws://diario.example/x',
  'file:///etc/passwd',
  'javascript:alert(1)',
  'mailto:a@b.example',
  'foo://bar baz/',
  'foo://[x]/',
  'foo://a:99999/',
  'foo://a:12/',
  'foo:',
  '1http://x',
  'no es url',
  '',
  '//diario.example/',
  'https://diario.example/' + 'x'.repeat(10),
];

const url = (input) => {
  try {
    const u = new URL(input);
    return {
      ok: true,
      protocol: u.protocol,
      username: u.username,
      password: u.password,
      hostname: u.hostname,
      port: u.port,
      href: u.href,
    };
  } catch {
    return { ok: false };
  }
};

const DATES = [
  '2026-11-02T15:04:05Z',
  '2026-11-02T15:04:05.123456Z',
  '2026-11-02T15:04:05+05:30',
  '2026-11-02T15:04:05-03:00',
  '2026-11-02T15:04',
  '2026-11-02',
  '2026-11',
  '2026',
  '+002026-11-02T00:00:00Z',
  '-000001-01-01T00:00:00Z',
  '2026-02-30T00:00:00Z',
  '2026-13-01',
  '2026-11-02T24:00:00Z',
  '2026-11-02T24:00:01Z',
  '2026-11-02T23:60:00Z',
  '2026-11-02t15:04:05z',
  '2026-11-02 15:04:05',
  '2026-11-02 15:04:05 -0500',
  'Mon, 02 Nov 2026 15:04:05 GMT',
  'Mon, 02 Nov 2026 15:04:05 +0000',
  'Mon, 02 Nov 2026 15:04:05 -0500',
  'Mon, 2 Nov 2026 15:04:05 EST',
  'Mon, 02 Nov 2026 15:04:05 EDT',
  'Mon, 02 Nov 2026 15:04:05 CST',
  'Mon, 02 Nov 2026 15:04:05 PDT',
  'Mon, 02 Nov 2026 15:04:05 UT',
  'Mon, 02 Nov 2026 15:04:05 Z',
  'Mon, 02 Nov 26 15:04:05 GMT',
  'Mon, 02 Nov 96 15:04:05 GMT',
  '02 Nov 2026 15:04 GMT',
  '02 Nov 2026',
  'Monday, 02-Nov-26 15:04:05 GMT',
  'Mon, 02 November 2026 15:04:05 GMT',
  'Mon, 31 Feb 2026 15:04:05 GMT',
  'Mon, 32 Nov 2026 15:04:05 GMT',
  'Mon, 02 Nov 2026 25:04:05 GMT',
  'Mon, 02 Nov 2026 15:04:05 +0100 (CET)',
  'Nov 2 2026 15:04:05 GMT+0200',
  'Nov 2, 2026',
  'Mon Nov 02 2026 15:04:05 GMT-0500',
  'garbage',
  '',
  'fecha rara',
];

const dateOf = (value) => {
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
};

const FEEDS = [
  FEED,
  '',
  'texto sin xml',
  '<rss><channel></channel></rss>',
  '<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Atom uno</title><id>urn:uno</id><link href="https://atom.example/1"/><updated>2026-11-01T00:00:00Z</updated><summary type="html">&lt;b&gt;Resumen&lt;/b&gt;</summary></entry><entry><title>Atom dos</title><link rel="self" href="https://atom.example/self"/><link rel="alternate" href="https://atom.example/2?a=1&amp;b=2"/><published>Mon, 02 Nov 2026 10:00:00 GMT</published><content>Contenido</content></entry><entry><title>Atom tres</title><link rel="alternate" href="javascript:alert(1)"/><link href="https://atom.example/3"/></entry><entry><title>Atom cuatro</title><link href=\'https://atom.example/4\' rel=\'alternate\'/></entry></feed>',
  '<rdf:RDF><item><title>RDF</title><link>https://rdf.example/1</link><dc:date>2026-11-01</dc:date></item></rdf:RDF>',
  '<rss><item><title>Sin cierre</title><link>https://x.example/</link>',
  '<rss><item><title>' + 'T'.repeat(600) + '</title><link>https://x.example/</link><guid>' + 'G'.repeat(600) + '</guid><description>' + 'D'.repeat(2000) + '</description></item></rss>',
  '<rss><item><title>' + 'T'.repeat(499) + '😀</title><link>https://x.example/</link></item></rss>',
  '<rss>' + Array.from({ length: 60 }, (_, i) => `<item><title>N${i}</title><link>https://x.example/${i}</link></item>`).join('') + '</rss>',
  '<rss><item ><title  lang="es">Con atributos</title><link>https://x.example/a</link><guid isPermaLink="true">https://x.example/a</guid></item><itemx><title>No</title></itemx></rss>',
  '<rss><item>\n<title>Espacios y　raros</title>\n<link>\nhttps://x.example/b\n</link></item></rss>',
  '<rss><item><title><![CDATA[ <b>Negrita</b> &amp; CDATA ]]></title><link>https://x.example/c</link><description><![CDATA[a]]> b]]></description></item></rss>',
  '<rss><item><title>&#65;&#x42;&#X43;&#0;&#9999999;&#xD800;&unknown;&AMP;&Lt;</title><link>https://x.example/d</link></item></rss>',
  '<rss><item><title>Script</title><link>https://x.example/e</link><description>&lt;SCRIPT type="x"&gt;mal()&lt;/script&gt;bien &lt;style&gt;x&lt;/STYLE&gt;fin</description></item></rss>',
  '<rss><ITEM><Title>Caso</Title><LINK>https://x.example/f</LINK><PUBDATE>Mon, 02 Nov 2026 15:04:05 GMT</PUBDATE></ITEM></rss>',
  '<rss><item><title>Fecha mala</title><link>https://x.example/g</link><pubDate>no es fecha</pubDate></item></rss>',
  '<feed><entry><title>Sin link</title><id>x</id></entry></feed>',
  '<rss><entry><title>Mezcla</title><link href="https://x.example/h"/></entry><item><title>Item</title><link>https://x.example/i</link></item></rss>',
];

const KEYWORDS = [
  [{ title: 'Contaminación del río', summary: '' }, ['contaminacion', 'RÍO', 'rio', 'agua', '', '  ', 'del río', 'ción']],
  [{ title: 'MINERÍA ilegal', summary: 'en la región' }, ['minería', 'mineria ilegal', 'region', 'ilegal en']],
  [{ title: 'ΣΟΦΟΣ', summary: 'Straße' }, ['σοφος', 'σοφοσ', 'strasse', 'straße']],
  [{ title: 'agua-potable', summary: '' }, ['agua potable', 'agua-potable', 'agua_potable']],
  [{ title: 'Año 2026', summary: '' }, ['2026', 'ano', 'año']],
];

const PROBLEMS = [
  'https://diario.example/rss',
  'http://diario.example/rss',
  'https://x'.padEnd(501, 'x'),
  'https://ñandú.example/',
  'https://localhost',
  'https://LOCALHOST',
  'https://diario',
  'https://a.local',
  'https://a.localhost.',
  'https://[::1]',
  'https://1.2.3.4',
  'https://0x7f.1',
  'https://a:b@c.example',
  'https://c.example:8443',
  'https://c.example:443',
  'no es url',
];

// The gateways over a fake fetch: each case is the fetched answer (or a thrown error) and, for
// feeds, the resolved addresses.
const RSS_CASES = [
  { addresses: ['93.184.216.34'], status: 200, body: FEED },
  { addresses: ['93.184.216.34'], status: 200, body: '<html>no feed</html>' },
  { addresses: ['93.184.216.34'], status: 200, body: '<rss></rss>' },
  { addresses: ['93.184.216.34'], status: 301, body: '' },
  { addresses: ['93.184.216.34'], status: 404, body: '' },
  { addresses: ['93.184.216.34'], status: 204, body: null },
  { addresses: ['93.184.216.34'], status: 200, large: 1024 * 1024 + 1 },
  { addresses: ['93.184.216.34'], status: 200, headers: { 'content-length': String(2 * 1024 * 1024) }, body: '<rss></rss>' },
  { addresses: ['93.184.216.34'], status: 200, bytes: [...Buffer.from('<?xml version="1.0" encoding="ISO-8859-1"?><rss><item><title>Caf'), 0xe9, 0x80, 0x81, ...Buffer.from('</title><link>https://x.example/</link></item></rss>')] },
  { addresses: ['93.184.216.34'], status: 200, bytes: [0xef, 0xbb, 0xbf, ...Buffer.from('<rss><item><title>BOM '), 0xff, ...Buffer.from('</title><link>https://x.example/</link></item></rss>')] },
  { addresses: [], status: 200, body: FEED },
  { addresses: ['10.0.0.1'], status: 200, body: FEED },
  { addresses: ['93.184.216.34', '127.0.0.1'], status: 200, body: FEED },
  { addresses: ['::ffff:192.168.1.1'], status: 200, body: FEED },
  { addresses: ['fd00::1'], status: 200, body: FEED },
  { addresses: ['100.64.0.1'], status: 200, body: FEED },
  { addresses: ['198.18.0.1'], status: 200, body: FEED },
  { addresses: ['169.254.169.254'], status: 200, body: FEED },
  { addresses: ['224.0.0.1'], status: 200, body: FEED },
  { addresses: ['2606:4700::1'], status: 200, body: FEED },
  { addresses: 'throw', status: 200, body: FEED },
  { addresses: ['93.184.216.34'], throws: true },
  { url: 'http://diario.example/rss', addresses: ['93.184.216.34'], status: 200, body: FEED },
  { url: 'https://localhost/rss', addresses: ['93.184.216.34'], status: 200, body: FEED },
];

const post = (extra) => ({
  id: 7,
  link: 'https://www.defensoria.gob.pe/nota-7/',
  date_gmt: '2026-10-01T10:00:00',
  title: { rendered: 'T&iacute;tulo &amp; <b>negrita</b> &#8220;cita&#8221;' },
  excerpt: { rendered: '<p>Extracto<script>x()</script> con&nbsp;espacio</p>\n' },
  extra: 'ignorado',
  ...extra,
});
const OFFICIAL_CASES = [
  { status: 200, body: JSON.stringify([post({})]) },
  { status: 200, body: JSON.stringify([]) },
  { status: 200, body: JSON.stringify([post({}), post({ id: 8, link: 'https://www.defensoria.gob.pe/a/../b?x=ñ' })]) },
  { status: 200, body: JSON.stringify(Array.from({ length: 11 }, (_, i) => post({ id: i + 1 }))) },
  { status: 200, body: JSON.stringify([post({ id: 0 })]) },
  { status: 200, body: JSON.stringify([post({ id: 1.5 })]) },
  { status: 200, body: JSON.stringify([post({ id: '7' })]) },
  { status: 200, body: JSON.stringify([post({ link: 'https://evil.example/' })]) },
  { status: 200, body: JSON.stringify([post({ link: 'https://www.defensoria.gob.pe.evil.example/' })]) },
  { status: 200, body: JSON.stringify([post({ link: 'http://www.defensoria.gob.pe/x' })]) },
  { status: 200, body: JSON.stringify([post({ link: 'https://www.defensoria.gob.pe:8443/x' })]) },
  { status: 200, body: JSON.stringify([post({ link: 'https://www.defensoria.gob.pe@evil.example/' })]) },
  { status: 200, body: JSON.stringify([post({ date_gmt: '2026-02-30T00:00:00' })]) },
  { status: 200, body: JSON.stringify([post({ date_gmt: '2026-10-01T24:00:00' })]) },
  { status: 200, body: JSON.stringify([post({ date_gmt: '2026-10-01 10:00:00' })]) },
  { status: 200, body: JSON.stringify([post({ title: 'plano' })]) },
  { status: 200, longTitle: 100001 },
  { status: 200, body: JSON.stringify([post({ title: { rendered: 'T'.repeat(600) }, excerpt: { rendered: 'E'.repeat(2000) } })]) },
  { status: 200, body: JSON.stringify({ id: 7 }) },
  { status: 200, body: 'no es json' },
  { status: 200, body: '﻿[]' },
  { status: 500, body: '[]' },
  { status: 302, body: '[]' },
  { status: 200, large: 512 * 1024 + 1 },
  { status: 200, headers: { 'content-length': String(600 * 1024) }, body: '[]' },
  { throws: true },
];

const respond = (c) => {
  if (c.throws) throw new TypeError('fetch failed');
  if (c.longTitle) c = { ...c, body: JSON.stringify([post({ title: { rendered: 'x'.repeat(c.longTitle) } })]) };
  const body = c.large ? 'x'.repeat(c.large) : c.bytes ? new Uint8Array(c.bytes) : c.body;
  return new Response(body, { status: c.status, headers: c.headers ?? {} });
};

const rss = [];
for (const c of RSS_CASES) {
  const gateway = createRssFeedGateway({
    fetch: async (_url, init) => {
      if (init.redirect !== 'manual') throw new Error('redirects must be manual');
      return respond(c);
    },
    resolve: async () => {
      if (c.addresses === 'throw') throw new Error('ENOTFOUND');
      return c.addresses;
    },
  });
  try {
    const items = await gateway.read(c.url ?? 'https://diario.example/rss');
    rss.push({ ...c, bytes: undefined, body: undefined, hex: hexOf(c), items });
  } catch (error) {
    rss.push({ ...c, bytes: undefined, body: undefined, hex: hexOf(c), error: error.message });
  }
}

function hexOf(c) {
  if (c.longTitle || c.large) return null;
  if (c.bytes) return Buffer.from(c.bytes).toString('hex');
  if (typeof c.body === 'string') return Buffer.from(c.body).toString('hex');
  return null;
}

const official = [];
for (const c of OFFICIAL_CASES) {
  let requested = '';
  const gateway = createOfficialSourceGateway({
    fetch: async (u, init) => {
      requested = u;
      if (init.redirect !== 'error') throw new Error('redirects must fail');
      if (c.status >= 300 && c.status < 400) throw new TypeError('redirect');
      return respond(c);
    },
  });
  for (const [call, run] of [
    ['preview', () => gateway.preview('agua & ñ+x')],
    ['get', () => gateway.get(7)],
  ]) {
    try {
      official.push({ call, case: { ...c, body: undefined }, hex: hexOf(c), posts: [await run()].flat(), url: requested });
    } catch (error) {
      official.push({ call, case: { ...c, body: undefined }, hex: hexOf(c), error: error.message, url: requested });
    }
  }
}
for (const query of ['x'.repeat(101), 'a\u0000b', '😀'.repeat(50), '😀'.repeat(51)]) {
  try {
    await createOfficialSourceGateway({ fetch: async () => respond({ status: 200, body: '[]' }) }).preview(query);
    official.push({ call: 'query', query, posts: [] });
  } catch (error) {
    official.push({ call: 'query', query, error: error.message });
  }
}

const fixture = {
  urls: URLS.map((input) => ({ input, ...url(input) })),
  dates: DATES.map((input) => ({ input, iso: dateOf(input) })),
  feeds: FEEDS.map((xml) => ({ xml, items: parseFeed(xml) })),
  keywords: KEYWORDS.map(([item, keywords]) => ({
    item,
    keywords,
    matched: matchedKeywords({ key: 'k', link: 'l', publishedAt: null, ...item }, keywords),
  })),
  problems: PROBLEMS.map((input) => ({ input, problem: feedUrlProblem(input) })),
  rss,
  official,
};

const text = await format(JSON.stringify(fixture), { ...(await resolveConfig(OUT)), filepath: OUT });
if (process.argv.includes('--check')) {
  if (readFileSync(OUT, 'utf8') !== text) {
    console.error('domain.json drifted from the TypeScript domain; rerun without --check');
    process.exit(1);
  }
} else {
  writeFileSync(OUT, text);
}
