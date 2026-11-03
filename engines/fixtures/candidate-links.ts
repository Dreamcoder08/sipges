/**
 * Generates the parity fixtures of the Rust candidate-links engine (engines/crates/candidate-links)
 * from the TypeScript engine (apps/api/src/contexts/analytics/domain/candidate-links.ts). Every
 * input is synthetic.
 *
 *   node engines/fixtures/candidate-links.ts          # rewrite the fixtures
 *   node engines/fixtures/candidate-links.ts --check  # fail when the committed fixtures are stale
 *
 * Each case stores the request as raw JSON text (`{records}`, a RecordsByModule object) and the
 * value as `JSON.stringify(candidatePairs(extendedRecords(records)))`, which the Rust engine must
 * reproduce byte for byte.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { syntheticRecords } from '../../apps/api/bench/synthetic.ts';
import { candidatePairs } from '../../apps/api/src/contexts/analytics/domain/candidate-links.ts';
import {
  EXTENDED_MODULES,
  type RecordsByModule,
  extendedRecords,
} from '../../apps/api/src/contexts/analytics/domain/records.ts';

type Payload = Record<string, unknown>;
type Case = { readonly name: string; readonly request: string; readonly value: string };

const FIXTURES = fileURLToPath(new URL('./candidate-links.json', import.meta.url));
const MODULES = Object.values(EXTENDED_MODULES) as string[];

const cases: Case[] = [];

/** A case whose request is raw JSON text: key order and duplicates reach the engine as written. */
const addText = (name: string, request: string) => {
  const parsed = JSON.parse(request) as { records?: RecordsByModule | null };
  const value = JSON.stringify(candidatePairs(extendedRecords(parsed.records ?? {})));
  cases.push({ name, request, value });
};

/** Wraps module → payload[] as stored records `{id: "<MOD>-<i>", payload}`. */
const stored = (byModule: Record<string, readonly Payload[]>, limit = Infinity) =>
  Object.fromEntries(
    Object.entries(byModule).map(([module, rows]) => [
      module,
      rows.slice(0, limit).map((payload, i) => ({ id: `${module}-${i}`, payload })),
    ]),
  );

const add = (name: string, byModule: Record<string, readonly Payload[]>) =>
  addText(name, JSON.stringify({ records: stored(byModule) }));

/** Every field candidate-links reads; the others never reach the result. */
const READ_FIELDS = new Set([
  'ID_Actor', 'ID_Demanda', 'ID_Proceso', 'Tema_ID', 'Vinculo_ID',
  'Registros_Relacionados', 'Referencias_ID',
  'Interes', 'Preocupacion', 'Posicion', 'Oportunidad', 'Tipo', 'Beneficiarios', 'Restricciones',
  'Asunto', 'Preguntas', 'Tema', 'Proceso',
]);

/**
 * Synthetic records of the extended modules only, 155 per module (the engine reads 150), with the
 * fields it reads, to keep the fixture small.
 */
const synthetic = (scale: number, seed: number) => {
  const all = syntheticRecords(scale, seed) as Record<string, Payload[]>;
  const pick = (x: Payload) => Object.fromEntries(Object.entries(x).filter(([k]) => READ_FIELDS.has(k)));
  return Object.fromEntries(MODULES.filter((m) => m !== 'Evaluaciones_AARC').map((m) => [m, (all[m] ?? []).slice(0, 155).map(pick)]));
};

// --- empty requests ------------------------------------------------------------------------------

addText('empty/no-records-field', '{}');
addText('empty/null-records', '{"records":null}');
addText('empty/empty-object', '{"records":{}}');
addText(
  'empty/empty-modules',
  `{"records":{${MODULES.map((m) => `${JSON.stringify(m)}:[]`).join(',')}}}`,
);

// --- synthetic volumes (the inputs of candidate-links-equivalence.test.ts) -----------------------

for (const [scale, seed] of [
  [1, 1],
  [1, 5],
  [3, 2],
  [10, 3],
] as const) {
  add(`synthetic/${scale}x-seed${seed}-max-pairs`, synthetic(scale, seed));
}

// Only a few records keep text, so the pairs stay under MAX_PAIRS (equivalence test, sparse case).
const sparse = (() => {
  const base = synthetic(1, 9);
  const out: Record<string, Payload[]> = {};
  for (const [module, rows] of Object.entries(base)) {
    out[module] = rows.map((x, i) => ({
      ...x,
      Interes: i % 7 === 0 ? x['Interes'] : '',
      Preocupacion: '',
      Posicion: '',
      Asunto: i % 9 === 0 ? x['Asunto'] : '',
      Preguntas: '',
      Oportunidad: i % 8 === 0 ? x['Oportunidad'] : '',
      Tipo: '',
      Beneficiarios: '',
      Restricciones: '',
      Tema: i % 6 === 0 ? x['Tema'] : '',
      Proceso: '',
      Tema_ID: i % 5 === 0 ? ` tem-${i % 3} ` : '',
      Registros_Relacionados:
        module === 'Hechos_Compartidos' && i % 4 === 0
          ? `Oportunidades-${i}, Dialogos-${i + 1}`
          : '',
      Referencias_ID: module !== 'Hechos_Compartidos' && i % 4 === 0 ? `Hechos_Compartidos-${i}` : '',
    }));
  }
  return out;
})();
add('synthetic/sparse-under-cap-three-criteria', sparse);

// Only the last spec (hechos × oportunidades) has text: earlier specs produce nothing.
add('synthetic/last-spec-only', {
  Hechos_Compartidos: (synthetic(1, 4).Hechos_Compartidos ?? []).map((x) => ({
    Asunto: x['Asunto'],
    Preguntas: x['Preguntas'],
  })),
  Oportunidades: (synthetic(1, 4).Oportunidades ?? []).map((x) => ({
    Restricciones: x['Restricciones'] ?? x['Oportunidad'],
  })),
});

// --- thematic terms ------------------------------------------------------------------------------

/** One interest against one opportunity: the pair appears when they share 2+ terms. */
const lexical = (name: string, interes: unknown, oportunidad: unknown) =>
  add(`terms/${name}`, {
    Intereses: [{ Interes: interes }],
    Oportunidades: [{ Oportunidad: oportunidad }],
  });

lexical('accents', 'Educación pública y Atención', 'educacion publica atencion');
lexical('enye', 'NIÑOS señalización', 'ninos senalizacion');
lexical('fi-ligature', 'ﬁnanciamiento ﬁscal', 'financiamiento fiscal');
lexical('full-width', 'ＡＧＵＡ ｐｅｓｃａ', 'agua pesca');
lexical('ordinal-and-superscript', 'aªaa x²yz agua', 'aaaa agua x2yz');
lexical('angstrom-and-kelvin', '\u212Breas \u00C5rbol \u212Ailos', 'areas arbol kilos');
lexical('dotted-capital-i', 'İSTANBUL İNDUSTRIA', 'istanbul industria');
lexical('sharp-s-breaks-words', 'STRAẞE straße agua', 'stra agua');
// Lower-casing happens before NFKD: ℡ expands to upper-case TEL, which [a-z] does not match.
lexical('lowercase-before-nfkd', 'ab℡cd ℡℡ agua pesca', 'abtelcd teltel agua pesca');
lexical('roman-numerals-and-km', 'ⅫⅫ ㎞㎞ agua', 'xiixii kmkm agua');
lexical('math-letters', '𝐚𝐠𝐮𝐚 𝐀𝐆𝐔𝐀 pesca', 'agua pesca');
lexical(
  'combining-marks',
  'agúa pesःca ri⃝os',
  'agua pesca rios',
);
lexical('stopwords', 'para proyecto comunidad agua territorio pesca', 'para proyecto comunidad');
lexical('stopwords-only-shared', 'para proyecto agua', 'para proyecto pesca');
lexical('three-and-four-letters', 'rio mar sol agua pesca', 'rio mar sol agua pesca');
lexical('one-shared-term-skipped', 'agua pesca', 'agua salud');
lexical('digits-and-punctuation', 'agua2pesca_salud-vias', 'agua pesca salud vias');
lexical('duplicates-and-more-than-eight', 'zeta yota beta alfa gama delta epsilon kappa lambda omega alfa', 'omega lambda kappa epsilon delta gama alfa beta yota zeta');
lexical('number-value', 1234, 'agua pesca');
add('terms/true-value', {
  Intereses: [{ Interes: true, Preocupacion: 'agua' }],
  Oportunidades: [{ Oportunidad: 'true agua' }],
});
lexical('object-value', { b: 'agua', 1: 'pesca', a: ['salud', null] }, 'agua pesca salud null');
lexical('array-value', ['Agua', 'Pesca', 3], 'agua pesca');
lexical('null-and-zero-and-false', null, 'none agua');
lexical('whitespace-and-bom', '﻿agua pesca salud', 'agua pesca salud');

// Several fields are joined with spaces in field order; missing and falsy fields join as ''.
add('terms/joined-fields', {
  Intereses: [
    { Interes: 'agua', Preocupacion: 'pesca', Posicion: 'salud vias' },
    { Interes: 0, Preocupacion: false, Posicion: 'agua pesca' },
  ],
  Oportunidades: [{ Oportunidad: 'agua', Tipo: 'pesca', Beneficiarios: null }],
  Dialogos: [{ Tema: 'salud', Proceso: 'vias agua' }],
});

// --- record links --------------------------------------------------------------------------------

add('links/explicit-id-fields', {
  Intereses: [
    { ID_Actor: ' ACT-1 ', Interes: 'agua' },
    { ID_Demanda: '﻿dem-9', Interes: 'agua' },
    { ID_Actor: '', ID_Demanda: '', Interes: 'agua' },
    { ID_Actor: null },
    { Vinculo_ID: 7 },
  ],
  Oportunidades: [
    { ID_Actor: 'act-1', Oportunidad: 'salud' },
    { ID_Demanda: 'DEM-9' },
    { ID_Actor: '' },
    { ID_Actor: null },
    { Vinculo_ID: '7', Tema_ID: 7 },
  ],
});
add('links/cross-references', {
  Hechos_Compartidos: [
    { Registros_Relacionados: 'Dialogos-0, ,Oportunidades-1', Asunto: 'agua' },
    { Registros_Relacionados: 'X-1,Y-2' },
    { Referencias_ID: null },
    { Registros_Relacionados: ' Dialogos-3 ' },
  ],
  Dialogos: [
    { Tema: 'agua' },
    { Registros_Relacionados: 'Y-2' },
    { Referencias_ID: null },
    { Referencias_ID: 'Hechos_Compartidos-3' },
  ],
  Oportunidades: [{}, { Referencias_ID: 'Z' }],
});
// The explicit link wins over a lexical match and keeps the shared terms.
add('links/explicit-and-lexical', {
  Intereses: [{ Tema_ID: 'T-1', Interes: 'agua pesca salud' }],
  Dialogos: [{ Tema_ID: 't-1', Tema: 'agua pesca' }],
});
// The stored record id replaces a payload `_id`; references compare against the stored id.
addText(
  'links/payload-id-overridden',
  '{"records":{"Hechos_Compartidos":[{"id":"H-1","payload":{"_id":"old","Registros_Relacionados":"D-1"}}],"Dialogos":[{"id":"D-1","payload":{"_id":"H-1"}},{"id":"old","payload":{}}]}}',
);
// Duplicated keys: the last value wins.
addText(
  'links/raw-duplicate-keys',
  '{"records":{"Intereses":[{"id":"I-1","payload":{"Interes":"agua pesca","Interes":"salud vias"}}],"Oportunidades":[{"id":"O-1","payload":{"Oportunidad":"salud vias"}},{"id":"O-2","payload":{"Oportunidad":"agua pesca"}}]}}',
);

// --- caps ------------------------------------------------------------------------------------------

// Only the first 150 records of a module are read: the 151st would match but is ignored.
add('caps/per-module-150', {
  Intereses: [
    ...Array.from({ length: 150 }, () => ({ Interes: 'nada' })),
    { Interes: 'agua pesca' },
  ],
  Oportunidades: [{ Oportunidad: 'agua pesca' }],
});
// Exactly MAX_PAIRS in the first spec: the early return skips every later spec.
add('caps/exactly-max-pairs', {
  Intereses: Array.from({ length: 12 }, () => ({ Interes: 'agua pesca' })),
  Oportunidades: Array.from({ length: 10 }, () => ({ Oportunidad: 'agua pesca' })),
  Dialogos: [{ Tema: 'agua pesca' }],
});
add('caps/cap-reached-in-a-later-spec', {
  Intereses: Array.from({ length: 17 }, () => ({ Interes: 'agua pesca' })),
  Oportunidades: Array.from({ length: 7 }, () => ({ Oportunidad: 'agua pesca' })),
  Dialogos: [{ Tema: 'agua pesca' }],
});
// Modules outside the extended set are ignored.
add('caps/other-modules-ignored', {
  Actores: [{ Interes: 'agua pesca' }],
  Intereses: [{ Interes: 'agua pesca' }],
  Evaluaciones_AARC: [{ Oportunidad: 'agua pesca' }],
});

// One entry per line keeps diffs reviewable.
const out = `{"source":"Generated by engines/fixtures/candidate-links.ts from apps/api/src/contexts/analytics/domain/candidate-links.ts on synthetic inputs.",
"cases":[
${cases.map((c) => JSON.stringify(c)).join(',\n')}
]}
`;

if (process.argv.includes('--check')) {
  if (readFileSync(FIXTURES, 'utf8') !== out) {
    console.error(`Stale fixtures: ${FIXTURES}. Run node engines/fixtures/candidate-links.ts`);
    process.exit(1);
  }
  console.log(`Fixtures are current (${cases.length} cases).`);
} else {
  writeFileSync(FIXTURES, out);
  console.log(`Wrote ${cases.length} cases to ${FIXTURES}`);
}
