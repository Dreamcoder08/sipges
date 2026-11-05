// Records what the TypeScript privacy context does on synthetic inputs, for the Go port's parity
// tests (../domain/fixtures_test.go, ../application/fixtures_test.go). Run from the repository
// root after changing either side:
//
//   node apps/api-go/internal/privacy/testdata/generate.mjs          # rewrites the fixture
//   node apps/api-go/internal/privacy/testdata/generate.mjs --check  # exit 1 when it drifted
//
// A wider differential run, never committed: PRIVACY_FIXTURE_CASES=200000 PRIVACY_FIXTURE_SEED=7
// PRIVACY_FIXTURE_OUT=/some/scratch.json node ...generate.mjs, then the Go tests with
// PRIVACY_FIXTURE_FILE=/some/scratch.json.
//
// Every input is synthetic and built from a fixed seed: no real record is read.
import { createHash, createHmac } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { format, resolveConfig } from 'prettier';
import { createEgressGuard } from '../../../../api/src/contexts/privacy/application/egress-guard.ts';
import {
  FIELD_POLICIES,
  LIST_SEPARATOR,
  NAME_SOURCES,
  STORED_MODULES,
  TITLE_FIELDS,
} from '../../../../api/src/contexts/privacy/domain/allowlist.ts';
import {
  createPseudonymiser,
  foldName,
} from '../../../../api/src/contexts/privacy/domain/pseudonyms.ts';
import { sanitiseRecords } from '../../../../api/src/contexts/privacy/domain/sanitise.ts';
import {
  PLACEHOLDERS,
  scrubPatterns,
  scrubTruncated,
} from '../../../../api/src/contexts/privacy/domain/scrub.ts';
import { createPseudonymKeys } from '../../../../api/src/contexts/privacy/infrastructure/hmac-keys.ts';

const COMMITTED = fileURLToPath(new URL('./fixtures.json', import.meta.url));
const OUT = process.env.PRIVACY_FIXTURE_OUT ?? COMMITTED;
const CASES = Number(process.env.PRIVACY_FIXTURE_CASES ?? 700);
const SEED = Number(process.env.PRIVACY_FIXTURE_SEED ?? 20261104);

/** mulberry32: a small deterministic generator, so the fixture never changes between runs. */
const random = (seed) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const next = random(SEED);
const pick = (list) => list[Math.floor(next() * list.length)];
const count = (max) => Math.floor(next() * (max + 1));

const macFor = (key) => (message) => createHmac('sha256', key).update(message).digest('hex');

/** The synthetic people of a project: accents, case, punctuation and every odd script. */
const NAME_SETS = {
  plain: [
    { kind: 'Actor', name: 'Comunidad Campesina Los Algarrobos' },
    { kind: 'Persona', name: 'José Pérez Núñez' },
    { kind: 'Persona', name: 'Marcos Villanueva Prado' },
    { kind: 'Org', name: 'Municipalidad de Sechura' },
    { kind: 'Org', name: 'Sechura' },
  ],
  ties: [
    // Same folded length: the order between them is localeCompare's.
    { kind: 'Persona', name: 'ana bel' },
    { kind: 'Org', name: 'bel ana' },
    { kind: 'Actor', name: 'Ana-Bel' },
    { kind: 'Persona', name: 'ana.bel' },
    { kind: 'Org', name: "ana'bel" },
    { kind: 'Org', name: 'ana bet' },
    { kind: 'Actor', name: 'aña bel' },
    { kind: 'Persona', name: '3M Perú' },
    { kind: 'Org', name: 'ANA_BEL' },
    { kind: 'Persona', name: 'ana/bel' },
    { kind: 'Org', name: 'Ñoño Ruiz' },
    { kind: 'Actor', name: 'nono ruiz' },
    { kind: 'Persona', name: 'Nono Ruíz' },
  ],
  scripts: [
    { kind: 'Persona', name: 'Σωκράτης ΣΟΦΟΣ' },
    { kind: 'Persona', name: 'İbrahim Yıldız' },
    { kind: 'Org', name: 'Straße Müller' },
    { kind: 'Actor', name: '김민수' },
    { kind: 'Persona', name: '𝐀𝐧𝐚 Ruiz' },
    { kind: 'Persona', name: '😀 Ana' },
    { kind: 'Org', name: 'ﬁnanciera Ñandú' },
    { kind: 'Persona', name: 'Al' },
    { kind: 'Persona', name: 'Ana' },
    { kind: 'Actor', name: '  Rosa  Elena Tapia  ' },
    { kind: 'Org', name: '́́' },
    { kind: 'Persona', name: 'Ｆｕｌｌ Ｗｉｄｔｈ' },
  ],
};

const SPOKEN = [
  'José Pérez Núñez',
  'JOSE PEREZ NUNEZ',
  'jose  perez\nnunez',
  'José Pérez Nũñez',
  'José-Pérez-Núñez',
  'José. Pérez, Núñez',
  'J.o.s.é',
  'Marcos Villanueva Prado',
  'Marcos Villan',
  'eva Prado',
  'nueva Prado',
  'Marcos',
  'Municipalidad de Sechura',
  'Sechura',
  'Sechuranos',
  'comunidad campesina los algarrobos',
  'ana bel',
  'bel ana',
  'ana bel ana',
  'bel ana bel',
  'Ana-Bel',
  "Ana'Bel",
  'Ana_Bel',
  'ANA/BEL',
  '3m peru',
  'Ñoño Ruiz',
  'nono ruiz',
  'ΣΩΚΡΆΤΗΣ σοφος',
  'σωκρατης σοφοσ',
  'ibrahim yıldız',
  'STRASSE MÜLLER',
  'straße müller',
  '김민수',
  '김민수씨',
  '𝐀𝐧𝐚 ruiz',
  '𝐚𝐧𝐚 RUIZ',
  '😀 ana',
  '😀😀 Ana😀',
  'FINANCIERA ñandu',
  'ﬁnanciera ñandú',
  'rosa elena tapia',
  'ROSA ELENA TAPIA',
  'Ｆｕｌｌ ｗｉｄｔｈ',
];
const CONTACTS = [
  'a.b+c@mail.example.org',
  'JOSÉ.PÉREZ@Ejemplo.PE',
  'ñandú@correo.pe',
  'a@b',
  'x@y.z.w!',
  'a@-b.c',
  '@b.c',
  'a@@b.c',
  '名前@例え.テスト',
  '𝐚𝐛@𝐜.𝐝',
  'partial@exam',
  '987654321',
  '987 654 321',
  '987-654-321',
  '987.654.321',
  '9 8 7 6 5 4 3 2 1',
  '+51 987654321',
  '+51987654321',
  '0051 987-654-321',
  '51987654321',
  '9876543210',
  '98765432',
  '(01) 234-5678',
  '(073) 123456',
  '(1)234 567',
  '073-123456',
  '01 2345678',
  '01.2345678',
  '012345678',
  'DNI 45678912',
  'dni: 45678912',
  'D.N.I. N° 45678912',
  'd n i 45678912',
  'D. N. I. nº45678912',
  'DNI Nro. 45678912',
  'DNI número 45678912',
  'DNI NÚMERO 45678912',
  'doc. de identidad 45678912',
  'Documento Nacional de Identidad: 45678912',
  'documento 45678912',
  'DNI 456789123',
  'DNI 4567891',
  'RUC 20123456789',
  'ruc: 20123456789',
  'RUC-20123456789',
  'RUC 201234567890',
  '１２３４５６７８',
  '12345 67890',
  '123-456-789',
];
const GLUE = [
  ' ',
  ' ',
  ' ',
  '  ',
  ', ',
  '. ',
  ': ',
  '; ',
  '-',
  '/',
  '_',
  '(',
  ')',
  '"',
  '«',
  '»',
  '\n',
  '\t',
  ' ',
  ' ',
  '​',
  '﻿',
  ' ',
  '\u0085',
  '…',
  ' … ',
  'a',
  'é',
  '9',
  '𝐀',
  '😀',
  'ſ',
  'K',
  '́',
  'y',
  ' y ',
  ' e ',
  ' Y ',
  '&',
];
const WORDS = [
  'habló con',
  'correo',
  'fono',
  'el acuerdo',
  'según',
  'ayer',
  'de',
  'y',
  'dni',
  'ruc',
];

/** One adversarial sentence: names, contact data and every separator, in random order. */
const sentence = () => {
  const parts = [];
  for (let n = 1 + count(5); n > 0; n--) {
    parts.push(pick(pick([SPOKEN, CONTACTS, WORDS])));
    parts.push(pick(GLUE));
  }
  return parts.join('');
};
/** A sentence cut with the ontology's mark, with a long tail so the 80-unit window bites. */
const cut = () => {
  const body = sentence();
  const filler = pick(['', '', 'x', '😀'.repeat(50), 'palabra '.repeat(14)]);
  return pick([
    `${body}…`,
    `${body} … `,
    `…${body}`,
    ` … ${body}`,
    `…${body}…`,
    `${filler}${body.slice(0, 1 + count(body.length))}…`,
    `…${body.slice(count(body.length))}${filler}`,
  ]);
};

const EXPLICIT_PATTERNS = [
  ...CONTACTS,
  ...CONTACTS.map((c) => `llamar al ${c} hoy.`),
  'correo a.b+c@mail.example.org hoy',
  'cel +51 987-654-321.',
  'cel 0051987654321',
  'presupuesto de 45678912 soles',
  'fecha 2026-10-12 y 12 de octubre',
  'avance 85% en 3 meses',
  'coordenadas -5.5571 -80.8222',
  'xDNI 45678912',
  'éDNI 45678912',
  '_DNI 45678912',
  'ſDNI 45678912',
  'KDNI 45678912',
  'KRUC 20123456789',
  '9DNI 45678912',
  'DNI45678912',
  'DNI-45678912',
  'DNI#45678912',
  'DNI 45678912',
  'DNI　45678912',
  'DNI​45678912',
  'dni  :  45678912',
  'DNI 45678912 y DNI 45678913',
  'DNI 45678912DNI 45678913',
  'DNI 123456789 DNI 12345678',
  'tel987654321',
  'é987654321',
  '٣987654321',
  '_987654321',
  '987654321a',
  '987654321 987654322',
  '987654321987654321',
  '+51+51 987654321',
  '0051987654321 051987654321',
  '(01)234-5678(01)234-5678',
  '(01) 234-56789',
  '073-1234567',
  '073-12345678',
  'a@b.c@d.e',
  'a@b.c.d@e.f',
  'a.@b.c.',
  'foo@bar-.baz-',
  'partial@exam…',
  'partial@exam.ple …  ',
  'correo: partial@…',
  'p@a.b …',
  'x y@ …',
  'llamar 98765 …',
  'llamar 9876 …',
  'llamar 987 65…',
  'llamar 98-76-5 …',
  '…98765 resto',
  ' … 987.654 resto',
  '…9876 resto',
  '… a 98765',
  '…98765…',
  '…12345 67890…',
  '…',
  '……',
  ' … ',
  '',
  ' ',
];
const FRAGMENTS = [
  'Marcos Villan…',
  'Marcos Villanueva Pra …',
  'dijo Marcos V…',
  'dijo Mar…',
  'dijo Ma…',
  '…eva Prado',
  '…nueva Prado cerró',
  '…Prado',
  '…ado',
  'Municipalidad de Sec…',
  '…de Sechura hoy',
  '…los Algarrobos y Marcos Villan…',
  'ana b…',
  'bel a…',
  '…l ana',
  '…a bel',
  '𝐀𝐧…',
  '…𝐧𝐚 ruiz',
  '😀 A…',
  '…😀 ana',
];

const scrubScenarios = () => {
  const out = {};
  for (const [set, names] of Object.entries(NAME_SETS)) {
    const p = createPseudonymiser({ mac: macFor(`clave-${set}`), names });
    const inputs = [...SPOKEN, ...CONTACTS, ...FRAGMENTS];
    for (let n = 0; n < CASES; n++) inputs.push(next() < 0.5 ? sentence() : cut());
    out[set] = {
      key: `clave-${set}`,
      names,
      scrub: inputs.map((input) => [input, p.scrub(input)]),
      pseudonym: ['Actor', 'Persona', 'Org'].flatMap((kind) =>
        [...SPOKEN.slice(0, 12), ...names.map((n) => n.name), '', '́'].map((name) => [
          kind,
          name,
          p.pseudonym(kind, name),
        ]),
      ),
      kindOf: [...SPOKEN, ...names.map((n) => n.name), 'Nadie'].map((name) => [
        name,
        p.kindOf(name) ?? null,
      ]),
    };
  }
  return out;
};

const patternCases = () => {
  const inputs = [...EXPLICIT_PATTERNS];
  for (let n = 0; n < CASES; n++) inputs.push(next() < 0.5 ? sentence() : cut());
  return inputs.map((input) => [input, scrubPatterns(input), scrubTruncated(input)]);
};

const SEPARATED = [
  'Ana, Luis; Eva/Rosa & Juan\nPedro',
  'Ana y Luis e Eva Y Rosa E Juan',
  'Ana  y  Luis',
  'Ana y Luis',
  'Ana y',
  'y Luis',
  ', Ana,, Luis ,',
  'Yolanda Eyzaguirre y Ernesto',
  'Ana yLuis',
  '',
  ' ',
  ',',
];

const splitCases = () => {
  const inputs = [...SEPARATED];
  for (let n = 0; n < CASES / 5; n++) inputs.push(sentence());
  return inputs.map((input) => [input, input.split(LIST_SEPARATOR)]);
};

const MODULES = [...Object.keys(FIELD_POLICIES), 'desconocido', '__proto__', 'constructor'];
const RAW_VALUES = () =>
  pick([
    'José Pérez Núñez',
    'Ana, Luis y Marcos Villanueva Prado',
    ' , y ',
    '  texto con espacios  ',
    '   ',
    '',
    null,
    0,
    -0,
    1.5,
    1e21,
    1e-7,
    123456789,
    987654321,
    true,
    false,
    ['lista'],
    { objeto: 1 },
    'correo a.b@x.org',
    sentence(),
    cut(),
  ]);

const FIELD_NAMES = (module) => [
  ...Object.keys(FIELD_POLICIES[module] ?? {}),
  'Posicion_Proyecto',
  'Telefono',
  'Campo nuevo',
  'Tono',
];

const recordOf = (index) => {
  const module = pick(MODULES);
  const fields = [];
  const names = FIELD_NAMES(module);
  for (let n = count(8); n > 0; n--) fields.push([pick(names), RAW_VALUES()]);
  const title = pick([undefined, '', '  ', 'José Pérez Núñez', 'Marcos Villan…', sentence()]);
  const date = pick([undefined, null, '', '  ', '2026-10-12', 'el 987654321']);
  return {
    module,
    id: pick([`R-${index}`, 'J.P. 987654321', 'José Pérez Núñez', 'a.b@x.org']),
    ...(title === undefined ? {} : { title }),
    ...(date === undefined ? {} : { date }),
    marking: pick(['publico', 'interno', 'interno', 'restringido', null, '', 'secreto']),
    fields,
  };
};

const toRaw = (record) => ({
  ...record,
  fields: Object.fromEntries(record.fields),
});

/** Keeps each field name's last value at its first position, as an object built in order does. */
const canonical = (record) => ({
  ...record,
  fields: Object.entries(toRaw(record).fields).map(([k, v]) => [k, Object.is(v, -0) ? 0 : v]),
});

const sanitiseCases = () => {
  const out = [];
  for (const set of Object.keys(NAME_SETS)) {
    const p = createPseudonymiser({ mac: macFor(`clave-${set}`), names: NAME_SETS[set] });
    for (let n = 0; n < Math.max(8, CASES / 90); n++) {
      const records = Array.from({ length: 1 + count(5) }, (_, i) => recordOf(`${n}-${i}`));
      out.push({
        set,
        records: records.map(canonical),
        expected: sanitiseRecords(p, records.map(toRaw)),
      });
    }
  }
  for (const module of Object.keys(FIELD_POLICIES)) {
    const p = createPseudonymiser({ mac: macFor('clave-plain'), names: NAME_SETS.plain });
    const fields = Object.keys(FIELD_POLICIES[module]).map((field) => [
      field,
      `José Pérez Núñez, Marcos Villanueva Prado y a.b@x.org 987654321 ${field}`,
    ]);
    fields.push(['Posicion_Proyecto', 'En contra'], ['Telefono', '987654321']);
    const record = {
      module,
      id: `R-${module}`,
      title: 'José Pérez Núñez, Marcos Villan…',
      date: '2026-10-12',
      marking: 'interno',
      fields,
    };
    out.push({
      set: 'plain',
      records: [record],
      expected: sanitiseRecords(p, [toRaw(record)]),
    });
  }
  return out;
};

const AT = new Date('2026-11-04T12:00:00.000Z');

/** One guard run per scenario, with fakes for everything outside the guard. */
const guardCases = async () => {
  const keys = createPseudonymKeys(Buffer.alloc(32, 7));
  const scenario = async (name, input) => {
    const written = [];
    const guard = createEgressGuard({
      switch: { enabled: async () => input.enabled ?? true },
      names: { load: async () => NAME_SETS.plain },
      keys,
      log: {
        append: async (tenantId, entry) => {
          written.push({ tenantId, ...entry });
        },
      },
      clock: { now: () => AT },
    });
    const request = {
      tenantId: input.tenantId ?? 'SIPGES/PRJ-SECHURA',
      channel: input.channel ?? 'mcp',
      purpose: input.purpose ?? 'get_record',
      ...(input.actor === undefined ? {} : { actor: input.actor }),
    };
    const opened = await guard.open(request);
    if (!opened.ok) return { name, input, refused: opened.reason };
    const session = opened.session;
    const sanitised = session.records((input.records ?? []).map(toRaw));
    const payloads = await session.releaseMany(input.payloads ?? [{ records: sanitised }]);
    return {
      name,
      input,
      sanitised,
      released: payloads,
      // The database driver writes well-formed UTF-8: a lone surrogate becomes U+FFFD.
      audit: written.map((w) => ({ tenantId: w.tenantId, detail: w.detail.toWellFormed() })),
      text: session.text('Habló José Pérez Núñez, a.b@x.org'),
      allows: [
        session.allows('actores', 'Territorio'),
        session.allows('actores', 'Posicion_Proyecto'),
        session.allows('nada', 'Territorio'),
      ],
    };
  };
  const field = (i) => `Campo_${String(i).padStart(2, '0')}`;
  const wide = '😀'.repeat(40);
  const record = (id, overrides = {}) => ({
    module: 'eventos',
    id,
    title: 'Corte de agua',
    date: '2026-10-12',
    marking: 'interno',
    fields: [
      ['Descripcion_Hecho', 'Marcos Villanueva Prado llamó al 987654321'],
      ['Actor_Principal', 'José Pérez Núñez'],
      ['Telefono', '987654321'],
    ],
    ...overrides,
  });
  return [
    await scenario('refused while off', { enabled: false }),
    await scenario('one record', { records: [record('E-1')], actor: 'analista' }),
    await scenario('no actor', { records: [record('E-1')] }),
    await scenario('empty actor', { records: [record('E-1')], actor: '' }),
    await scenario('nothing released', { payloads: [], purpose: 'vacío' }),
    await scenario('text payload', {
      channel: 'analyst',
      purpose: 'briefing',
      payloads: ['Habló José Pérez Núñez, a.b@x.org ☎ 987654321'],
    }),
    await scenario('nested payload', {
      channel: 'embeddings',
      purpose: 'index',
      payloads: [
        { a: ['José Pérez Núñez', 1, true, null, { b: 'a.b@x.org' }], 'José Pérez Núñez': 2.5 },
        ['Sechura', 'Rosa'],
      ],
    }),
    await scenario('restricted and unknown', {
      records: [
        record('E-1'),
        record('E-2', { marking: 'restringido' }),
        record('E-3', { marking: null }),
        record('José Pérez Núñez', { marking: 'secreto' }),
      ],
    }),
    await scenario('over the record cap', {
      records: Array.from({ length: 103 }, (_, i) => record(`E-${i}`)),
    }),
    await scenario('over the withheld cap', {
      records: Array.from({ length: 102 }, (_, i) => record(`E-${i}`, { marking: 'restringido' })),
    }),
    await scenario('over the field cap', {
      records: [
        record('E-1', {
          fields: Array.from({ length: 23 }, (_, i) => [field(i), 'valor']),
        }),
      ],
    }),
    await scenario('a dropped field name cut inside an emoji', {
      records: [
        record('E-1', {
          fields: [
            [`x${wide}`, 'valor'],
            [`José Pérez Núñez ${'y'.repeat(70)}`, 'valor'],
          ],
        }),
      ],
    }),
    await scenario('repeated ids', { records: [record('E-1'), record('E-1')] }),
    await scenario('a project key', {
      tenantId: 'PARITY/OTRO',
      records: [record('E-1')],
    }),
  ];
};

const keyCases = () => {
  const keys = createPseudonymKeys(Buffer.from('0123456789abcdef0123456789abcdef'));
  return ['SIPGES/PRJ-SECHURA', 'PARITY/OTRO', 'Ñandú/😀'].flatMap((tenant) =>
    ['Persona\u0000jose perez nunez', 'Actor\u0000', 'Org\u0000ñ😀'].map((message) => [
      tenant,
      message,
      keys.macFor(tenant)(message),
    ]),
  );
};

/** Hash per 4096 code points of what Unicode decides here, so the fixture stays small. */
const unicodeBlocks = () => {
  const blocks = [];
  for (let block = 0; block < 0x110; block++) {
    const hash = createHash('sha256');
    for (let cp = block << 12; cp < (block + 1) << 12; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      const char = String.fromCodePoint(cp);
      const word = /[\p{L}\p{N}]/u.test(char) ? 'w' : '-';
      hash.update(`${cp} ${foldName(`a${char}a`)} ${word}\n`);
    }
    blocks.push(hash.digest('hex').slice(0, 16));
  }
  return blocks;
};

const fixture = {
  placeholders: PLACEHOLDERS,
  policies: Object.entries(FIELD_POLICIES).map(([slug, fields]) => ({
    slug,
    fields: Object.entries(fields).map(([field, policy]) => ({
      field,
      kind: policy.kind,
      entity: policy.entity ?? '',
      why: policy.why,
    })),
  })),
  storedModules: STORED_MODULES,
  titleFields: TITLE_FIELDS,
  nameSources: NAME_SOURCES,
  unicode: unicodeBlocks(),
  patterns: patternCases(),
  split: splitCases(),
  pseudonymisers: scrubScenarios(),
  sanitise: sanitiseCases(),
  keys: keyCases(),
  guard: await guardCases(),
};

/** Holds a lone surrogate as U+F0000 + its unit: JSON decoding in Go would lose it. */
const marked = (value) => {
  if (typeof value === 'string')
    return value.replace(/\p{Cs}/gu, (c) => String.fromCodePoint(0xf0000 + c.charCodeAt(0)));
  if (Array.isArray(value)) return value.map(marked);
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [marked(k), marked(v)]));
  return value;
};

const json = JSON.stringify(marked(fixture));
const text =
  OUT === COMMITTED
    ? await format(json, { ...(await resolveConfig(OUT)), parser: 'json' })
    : `${json}\n`;
if (process.argv.includes('--check')) {
  if (readFileSync(OUT, 'utf8') !== text) {
    console.error(`${OUT} is out of date: run this script without --check`);
    process.exit(1);
  }
} else {
  writeFileSync(OUT, text);
}
