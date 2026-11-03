// Records the TypeScript ontology domain's answers on synthetic inputs, for the Go port's test
// (../domain/fixtures_test.go). Run from the repository root after changing either side:
//
//   node apps/api-go/internal/ontology/testdata/generate.mjs          # rewrites the fixture
//   node apps/api-go/internal/ontology/testdata/generate.mjs --check  # exit 1 when it drifted
//
// Every input is synthetic: no real record is read.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { format, resolveConfig } from 'prettier';
import {
  INFERENCE_RULES,
  LINK_TYPES,
  OBJECT_TYPES,
  objectTypeForSlug,
  titleOf,
} from '../../../../api/src/contexts/ontology/domain/catalog.ts';
import {
  foldText,
  matchExcerpt,
  searchTerms,
  toPrefixQuery,
} from '../../../../api/src/contexts/ontology/domain/search.ts';
import {
  dayBound,
  summarize,
} from '../../../../api/src/contexts/ontology/application/ontology-service.ts';

const OUT = fileURLToPath(new URL('./fixtures.json', import.meta.url));

const TEXTS = [
  '',
  'Agua',
  'ÁGUA potable',
  'Comunidad San Pedro',
  'año de la niñez',
  'AÑO',
  'İzmir',
  'ßeta Straße',
  'ΟΔΟΣ ΣΟΦΙΑΣ',
  'ǅungla ǆ',
  'ﬁn ﬂor',
  'é compuesto',
  '😀 emoji y agua',
  '한국어 텍스트',
  'Ⅻ capítulo',
  '  espacios y\ttabs　 ',
  '﻿bom inicial',
  'x'.repeat(50) + 'agua' + 'y'.repeat(100),
  'Ñandú en Ñuñoa',
  'contaminación del río',
];

const QUERIES = [
  '',
  '   ',
  'agua',
  'Agua potable agua',
  'a b c 1 2 xy',
  'ÑANDÚ',
  'año-2024 / PRJ_01',
  'uno dos tres cuatro cinco seis siete ocho nueve diez',
  '😀 emoji',
  'İstanbul',
  'ﬁn',
  '%20 + &',
  '1',
  'ab',
];

const PAYLOADS = [
  {},
  {
    Descripcion_Hecho: 'Corte de agua en el caserío',
    Tipo_Evento: 'Conflicto',
    Fecha: '2026-01-02',
  },
  {
    Descripcion_Hecho: 12.5,
    Territorio: 'Sechura',
    Relevancia_Preliminar: 3,
    Estado_Validacion: true,
  },
  { Descripcion_Hecho: '  ', Territorio: '', Otro: 'agua del río', Zeta: 'agua' },
  { Descripcion_Hecho: 'x'.repeat(138) + '😀 resto', Tipo_Evento: '  Tipo  ' },
  { Descripcion_Hecho: 'x'.repeat(139) + '😀 resto' },
  { Descripcion_Hecho: 'x'.repeat(141) },
  { Descripcion_Hecho: 'x'.repeat(140) },
  { Descripcion_Hecho: null, Fecha: null, Tipo_Evento: ['lista'], Territorio: { a: 1 } },
  { Descripcion_Hecho: 1e21, Fecha: 20260102, Tipo_Evento: 0.1, Territorio: -0 },
  { 'Ñ campo': 'año agua', b: 'ÁGUA', a: 'nada', 10: 'agua diez', 2: 'agua dos' },
  { Descripcion_Hecho: 'İ'.repeat(30) + ' agua al final del texto largo que sigue y sigue' },
  { Descripcion_Hecho: '😀'.repeat(30) + 'agua' + '😀'.repeat(60) },
  { Descripcion_Hecho: '한국어'.repeat(20) + ' agua ' + 'z'.repeat(90) },
  { Descripcion_Hecho: 'é'.repeat(30) + 'agua' },
  { Descripcion_Hecho: '   agua   ', Territorio: '﻿ agua  ' },
];

const fold = TEXTS.map((text) => ({ text, out: foldText(text) }));
const terms = QUERIES.map((raw) => {
  const t = searchTerms(raw);
  return { raw, terms: t, query: toPrefixQuery(t) };
});

const excerpts = [];
for (const payload of PAYLOADS) {
  for (const raw of ['agua', 'año', 'xx', 'resto', 'nada zzz', '12', 'true', 'izmir', 'iii', '']) {
    const t = searchTerms(raw);
    excerpts.push({
      payload: JSON.stringify(payload),
      terms: t,
      preferred: ['Descripcion_Hecho', 'Tipo_Evento', 'Territorio'],
      out: JSON.stringify(
        matchExcerpt(payload, t, ['Descripcion_Hecho', 'Tipo_Evento', 'Territorio']),
      ),
    });
  }
}

const summaries = [];
for (const slug of ['eventos', 'actores', 'acciones', 'fuentes']) {
  const objectType = objectTypeForSlug(slug);
  for (const payload of PAYLOADS) {
    const row = {
      module: objectType.module,
      id: 'ID-1',
      payload,
      marking: 'interno',
      updatedAt: new Date(0),
    };
    const s = summarize(objectType, row);
    summaries.push({
      slug,
      payload: JSON.stringify(payload),
      title: JSON.stringify(titleOf(objectType, 'ID-1', payload)),
      out: JSON.stringify({
        module: s.slug,
        id: s.id,
        type_label: s.typeLabel,
        title: s.title,
        date: s.date,
        marking: s.marking,
        fields: s.fields,
      }),
    });
  }
}

const days = [];
for (const value of [
  '',
  '  ',
  '2024',
  '2024-02',
  '2024-13',
  '2024-00',
  '2024-02-30',
  ' 2024-01-01 ',
  '2024-1-1',
  '20241',
  '२०२४',
  '2024-01-01x',
  ' 2024　',
]) {
  for (const end of [false, true]) days.push({ value, end, out: dayBound(value, end) });
}

const catalog = JSON.stringify({
  object_types: OBJECT_TYPES.map((t) => ({
    module: t.slug,
    label: t.label,
    title_field: t.titleField,
    summary_fields: [...t.summaryFields],
    date_field: t.dateField,
  })),
  link_types: LINK_TYPES.map((t) => ({
    id: t.id,
    label: t.label,
    inverse_label: t.inverseLabel,
    sources: t.sources ? [...t.sources] : null,
    targets: t.targets ? [...t.targets] : null,
    symmetric: t.symmetric,
  })),
});
const rules = JSON.stringify(INFERENCE_RULES);

const text = await format(
  JSON.stringify({ catalog, rules, fold, terms, excerpts, summaries, days }),
  { ...(await resolveConfig(OUT)), filepath: OUT },
);
if (process.argv.includes('--check')) {
  if (readFileSync(OUT, 'utf8') !== text) {
    console.error(
      'fixtures.json drifted from the TypeScript ontology domain; rerun without --check',
    );
    process.exit(1);
  }
} else {
  writeFileSync(OUT, text);
}
