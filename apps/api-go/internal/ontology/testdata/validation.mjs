// Records how the TypeScript API validates the bodies of the ontology write routes (POST
// /system/links, PUT /system/links/:id/evidence, PUT /system/marking and POST
// /system/graph/neighbourhood): parseJson of apps/api/src/platform/http/validation.ts with the
// Zod schemas of @sipges/contracts, for the Go port's test (../domain/validation_test.go).
// Run from the repository root after changing either side:
//
//   node apps/api-go/internal/ontology/testdata/validation.mjs          # rewrites the fixture
//   node apps/api-go/internal/ontology/testdata/validation.mjs --check  # exit 1 when it drifted
//
// Every input is synthetic: no real record is read.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { format, resolveConfig } from 'prettier';
import {
  LinkEvidenceIn,
  LinkIn,
  MarkingIn,
  NeighbourhoodIn,
} from '../../../../../packages/contracts/src/ontology.ts';
import { LINK_TYPES, checkLink } from '../../../../api/src/contexts/ontology/domain/catalog.ts';
import { parseJson } from '../../../../api/src/platform/http/validation.ts';

const OUT = fileURLToPath(new URL('./validation.json', import.meta.url));

/** A Hono Context as parseJson reads it: the body through Request.json(), c.json(body, status). */
const context = (raw) => {
  const request = new Request('http://parity.invalid/', { method: 'POST', body: raw });
  return {
    req: { json: () => request.json() },
    json: (body, status = 200) => ({ status, body }),
  };
};

const run = async (schema, raw) => {
  const parsed = await parseJson(context(raw), schema);
  return parsed.ok ? { status: 200, body: { value: parsed.value } } : parsed.response;
};

const ref = (module, id) => ({ module, id });
const A = ref('actores', 'A1');
const B = ref('actores', 'A2');
const long = (n, unit = 'x') => unit.repeat(n);
const json = (value) => JSON.stringify(value);
const link = (extra) => json({ link_type: 'aliado_de', source: A, target: B, ...extra });

const COMMON = [
  '',
  ' ',
  'no es json',
  '{"a":1} sobra',
  'null',
  '[]',
  '[{}]',
  '"texto"',
  '5',
  'true',
  '1e400',
  '{}',
  '﻿{}',
];

const LINKS = [
  ...COMMON,
  link({}),
  `﻿${link({})}`,
  link({ note: 'Nota' }),
  link({ note: null }),
  link({ note: 5 }),
  link({ note: long(500) }),
  link({ note: long(501) }),
  link({ note: long(250, '😀') }),
  link({ note: long(251, '😀') }),
  link({ link_type: '' }),
  link({ link_type: long(40) }),
  link({ link_type: long(41) }),
  link({ link_type: 7 }),
  link({ link_type: null }),
  link({ link_type: [] }),
  link({ source: null }),
  link({ source: [] }),
  link({ source: {} }),
  link({ source: 'actores/A1' }),
  link({ source: ref('', '') }),
  link({ source: ref(long(41), long(201)) }),
  link({ source: ref('actores', long(200)) }),
  link({ source: ref('actores', long(100, '😀')) }),
  link({ source: ref('actores', long(101, '😀')) }),
  link({ source: ref('actores', 'A\u00001') }),
  link({ source: ref('actores', `${long(200)}\u0000`) }),
  link({ source: ref('actores', '\u0000') }),
  link({ source: { module: 'actores' } }),
  link({ source: { id: 'A1' } }),
  link({ source: { module: 1, id: true } }),
  link({ source: [[1]] }),
  link({ source: ref('actores', 'A1'), sobra: 1 }),
  json({ source: A, target: B }),
  json({ link_type: 'aliado_de', source: A }),
  json({ link_type: 'aliado_de' }),
  json({ link_type: 'aliado_de', target: B }),
  json({ link_type: 1, source: 2, target: 3, note: 4, evidence: 5 }),
  link({ evidence: null }),
  link({ evidence: ref('fuentes', 'F1') }),
  link({ evidence: ref('actores', 'F1') }),
  link({ evidence: ref('Fuentes', '') }),
  link({ evidence: { module: 'fuentes' } }),
  link({ evidence: {} }),
  link({ evidence: 5 }),
  link({ evidence: [] }),
  link({ evidence: 'fuentes' }),
  link({ evidence: ref('fuentes', long(201)) }),
  link({ evidence: ref('fuentes', 'F\u00001') }),
  '{"link_type":"aliado_de","link_type":"","source":{"module":"actores","id":"A1"},"target":{"module":"actores","id":"A2"}}',
  '{"link_type":"aliado_de","source":{"module":"actores","id":"\\ud800"},"target":{"module":"actores","id":"A2"}}',
  '{"link_type":"aliado_de","source":{"module":"actores","id":"A1"},"target":{"module":"actores","id":"A2"},"note":"  con espacios\\u3000 "}',
  '{"link_type":1e400,"source":{"module":"actores","id":"A1"},"target":{"module":"actores","id":"A2"}}',
  '{"link_type":"aliado_de","source":{"module":"actores","id":"A1"},"target":{"module":"actores","id":"A2"}',
  // Length checks read `.length` of any value, so objects with a "length" key count too.
  ...[
    0,
    41,
    '',
    'abc',
    ' 50 ',
    '0x10',
    '0b101',
    '1e1',
    'Infinity',
    '-Infinity',
    '1_0',
    null,
    true,
    false,
  ]
    .concat([[], [5], [50], ['7'], [null], [true], [[60]], [1, 2], [{}], {}])
    .map((length) => link({ link_type: { length } })),
  link({ source: { module: { length: 0 }, id: { length: 201 } } }),
  link({ source: { length: 0 } }),
  link({ note: { length: 501 } }),
  link({ note: [] }),
  link({ evidence: { module: 'fuentes', id: { length: 0 } } }),
  link({ evidence: { module: { length: 1 }, id: 'F' } }),
  link({ source: ref('actores', ['\u0000']) }),
  link({ link_type: long(41, '😀') }),
  link({ link_type: long(40, '😀') }),
  link({ source: ref('actores', `${long(199)}😀`) }),
  link({ source: ref('actores', '\ud83d') }),
];

const EVIDENCE = [
  ...COMMON,
  json({ evidence: null }),
  json({ evidence: ref('fuentes', 'F1') }),
  json({ evidence: ref('fuentes', 'F1'), sobra: true }),
  json({ evidence: ref('actores', 'F1') }),
  json({ evidence: ref('fuentes', '') }),
  json({ evidence: ref('', long(201)) }),
  json({ evidence: { id: 'F1' } }),
  json({ evidence: {} }),
  json({ evidence: 5 }),
  json({ evidence: false }),
  json({ evidence: [] }),
  json({ evidence: [ref('fuentes', 'F1')] }),
  json({ otra: ref('fuentes', 'F1') }),
  json({ evidence: { module: 'fuentes', id: ['x'] } }),
  json({ evidence: { length: 0 } }),
];

const marking = (extra) => json({ module: 'actores', id: 'A1', marking: 'restringido', ...extra });
const MARKINGS = [
  ...COMMON,
  marking({}),
  marking({ marking: 'publico' }),
  marking({ marking: 'interno' }),
  marking({ marking: 'secreto' }),
  marking({ marking: 'Restringido' }),
  marking({ marking: '' }),
  marking({ marking: null }),
  marking({ marking: 1 }),
  marking({ marking: ['restringido'] }),
  marking({ module: '' }),
  marking({ module: long(40) }),
  marking({ module: long(41) }),
  marking({ module: null }),
  marking({ id: '' }),
  marking({ id: long(200) }),
  marking({ id: long(201) }),
  marking({ id: 'A\u00001' }),
  marking({ id: 5 }),
  json({ module: 'actores', id: 'A1' }),
  json({ marking: 'restringido' }),
  json({ module: 1, id: 2, marking: 3 }),
  marking({ project_id: 'PRJ-SECHURA' }),
  marking({ marking: { length: 1 } }),
  marking({ id: { length: 0 } }),
  marking({ id: `${long(199)}😀` }),
  marking({ module: long(41, '😀') }),
];

const nb = (extra) => json({ seeds: [A], hops: [['aliado_de']], ...extra });
const NEIGHBOURHOODS = [
  ...COMMON,
  nb({}),
  nb({ fields: ['Territorio'] }),
  nb({ fields: [] }),
  nb({ fields: null }),
  nb({ fields: 'Territorio' }),
  nb({ fields: [''] }),
  nb({ fields: [long(60)] }),
  nb({ fields: [long(61)] }),
  nb({ fields: Array.from({ length: 24 }, (_, i) => `f${i}`) }),
  nb({ fields: Array.from({ length: 25 }, (_, i) => `f${i}`) }),
  nb({ fields: [...Array.from({ length: 25 }, (_, i) => `f${i}`), ''] }),
  nb({ fields: [1, 'ok', null] }),
  nb({ seeds: [] }),
  nb({ seeds: null }),
  nb({ seeds: A }),
  nb({ seeds: [5] }),
  nb({ seeds: [{}] }),
  nb({ seeds: [A, ref('', '')] }),
  nb({ seeds: Array.from({ length: 100 }, (_, i) => ref('actores', `A${i}`)) }),
  nb({ seeds: Array.from({ length: 101 }, (_, i) => ref('actores', `A${i}`)) }),
  nb({ seeds: [...Array.from({ length: 101 }, (_, i) => ref('actores', `A${i}`)), 5] }),
  nb({ seeds: [...Array.from({ length: 101 }, (_, i) => ref('actores', `A${i}`)), ref('', 'x')] }),
  nb({ seeds: [ref('actores', 'A\u00001')] }),
  nb({ hops: [] }),
  nb({ hops: null }),
  nb({ hops: [[]] }),
  nb({ hops: [[], []] }),
  nb({ hops: [['aliado_de'], ['origina']] }),
  nb({ hops: [['a'], ['b'], ['c']] }),
  nb({ hops: [[], [], []] }),
  nb({ hops: [['a'], [1], ['c']] }),
  nb({ hops: [['']] }),
  nb({ hops: [[long(40)]] }),
  nb({ hops: [[long(41)]] }),
  nb({ hops: [Array.from({ length: 20 }, () => 'aliado_de')] }),
  nb({ hops: [Array.from({ length: 21 }, () => 'aliado_de')] }),
  nb({ hops: [[...Array.from({ length: 21 }, () => 'aliado_de'), '']] }),
  nb({ hops: [5] }),
  nb({ hops: ['aliado_de'] }),
  nb({ hops: [[null]] }),
  nb({ hops: [['no_existe']] }),
  json({ hops: [['aliado_de']] }),
  json({ seeds: [A] }),
  json({ seeds: 1, hops: 2, fields: 3 }),
  json({ seeds: [], hops: [], fields: [''] }),
  nb({ seeds: '' }),
  nb({ seeds: 'x' }),
  nb({ seeds: { length: 0 } }),
  nb({ seeds: { length: 101 } }),
  nb({ hops: '' }),
  nb({ hops: 'abc' }),
  nb({ hops: [''] }),
  nb({ hops: ['abc', 'abcdefghijklmnopqrstuvwxyz'] }),
  nb({ hops: [{ length: 0 }] }),
  nb({ hops: [[], [Array.from({ length: 21 }, () => 'x')]] }),
  nb({ hops: [[Array.from({ length: 41 }, () => 'x')]] }),
  nb({ fields: long(25) }),
  nb({ fields: { length: 30 } }),
  nb({ fields: [{ length: 61 }] }),
  nb({ seeds: [{ length: 0 }] }),
];

const SCHEMAS = {
  link: LinkIn,
  evidence: LinkEvidenceIn,
  marking: MarkingIn,
  neighbourhood: NeighbourhoodIn,
};
const INPUTS = {
  link: LINKS,
  evidence: EVIDENCE,
  marking: MARKINGS,
  neighbourhood: NEIGHBOURHOODS,
};

const cases = [];
for (const [name, inputs] of Object.entries(INPUTS)) {
  for (const raw of inputs) {
    const { status, body } = await run(SCHEMAS[name], raw);
    cases.push({ schema: name, raw, status, body: JSON.stringify(body) });
  }
}

// checkLink over every link type, an unknown one, and pairs of object types (also unknown, and
// the same record at both ends).
const SLUGS = [
  'actores',
  'eventos',
  'demandas',
  'fuentes',
  'alertas',
  'acciones',
  'directorio',
  'Actores',
  'nada',
];
const checks = [];
for (const linkType of [...LINK_TYPES.map((t) => t.id), 'no_existe', '']) {
  for (const source of SLUGS) {
    for (const target of SLUGS) {
      for (const sameId of source === target ? [true, false] : [false]) {
        const ends = [ref(source, 'X1'), ref(target, sameId ? 'X1' : 'X2')];
        const [s, t] = ends.map((e) => ({ slug: e.module, id: e.id }));
        checks.push({ linkType, source: ends[0], target: ends[1], out: checkLink(linkType, s, t) });
      }
    }
  }
}

const text = await format(JSON.stringify({ cases, checks }), {
  ...(await resolveConfig(OUT)),
  filepath: OUT,
});
if (process.argv.includes('--check')) {
  if (readFileSync(OUT, 'utf8') !== text) {
    console.error('validation.json drifted from the TypeScript contracts; rerun without --check');
    process.exit(1);
  }
} else {
  writeFileSync(OUT, text);
}
