/**
 * Generates the parity fixtures of the Rust indicators engine from the TypeScript engine
 * (apps/api/src/contexts/indicators/domain). Every input is synthetic.
 *
 *   node engines/fixtures/generate.ts          # rewrite the fixtures
 *   node engines/fixtures/generate.ts --check  # fail when the committed fixtures are stale
 *
 * Each case stores the request and the response as raw JSON text: the request text is what the
 * engine parses (so key order and number spelling reach it untouched) and the response text is
 * `JSON.stringify` of the TypeScript result, which the Rust engine must reproduce byte for byte.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { syntheticRecords } from '../../apps/api/bench/synthetic.ts';
import {
  DEFAULT_IRSA_CONFIG,
  INDICATOR_CONFIG,
  type IndicatorsReport,
  type ModuleRecords,
  applyIrsaConfigPatch,
  computeIndicators,
  computeIrsa,
  pyFloat,
  pyRound,
  selectBand,
} from '../../apps/api/src/contexts/indicators/domain/index.ts';
import parity from '../../apps/api/test/indicators/python-parity.fixture.json' with { type: 'json' };

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Request = { readonly [key: string]: Json };
type Case = {
  readonly name: string;
  readonly request: string;
  readonly response: string;
  readonly compare: 'bytes' | 'error_code';
};

const here = (file: string) => fileURLToPath(new URL(file, import.meta.url));
const FIXTURES = here('./indicators.json');
const DEFAULTS = here('../crates/indicators/src/defaults.json');

const EMPTY: ModuleRecords = {
  Eventos: [],
  Actores: [],
  Demandas: [],
  Compromisos: [],
  Narrativas: [],
  Alertas: [],
  Acciones: [],
  Directorio_Territorial: [],
};
const INDICATOR_KEYS = Object.keys(EMPTY);

/** Reference implementation of the engine ABI over the TypeScript functions. */
const dispatch = (req: Request): unknown => {
  const meta = (req.meta ?? undefined) as Parameters<typeof computeIndicators>[1];
  const config = (req.config ?? DEFAULT_IRSA_CONFIG) as typeof DEFAULT_IRSA_CONFIG;
  switch (req.op) {
    case 'indicators':
      return computeIndicators(req.records as unknown as ModuleRecords, meta);
    case 'irsa': {
      const report =
        req.report === undefined
          ? computeIndicators(req.records as unknown as ModuleRecords, meta)
          : (req.report as unknown as IndicatorsReport);
      return computeIrsa(config, report);
    }
    case 'irsa_config_patch':
      return applyIrsaConfigPatch(
        config,
        req.patch as unknown as Parameters<typeof applyIrsaConfigPatch>[1],
      );
    case 'select_band':
      return selectBand(req.irsa as number, req.thresholds as typeof DEFAULT_IRSA_CONFIG.thresholds);
    case 'defaults':
      return { indicator_config: INDICATOR_CONFIG, irsa_config: DEFAULT_IRSA_CONFIG };
    default:
      throw new Error(`unknown op ${String(req.op)}`);
  }
};

const cases: Case[] = [];

/** A case whose request is built as an object (JavaScript key order). */
const add = (name: string, req: Request) => addText(name, JSON.stringify(req));

/** A case whose request is raw JSON text: key order and number spelling reach the engine as written. */
const addText = (name: string, request: string) => {
  const value = dispatch(JSON.parse(request) as Request);
  cases.push({ name, request, response: JSON.stringify({ ok: true, value }), compare: 'bytes' });
};

/** A case the TypeScript engine rejects by throwing; the Rust engine must return this error code. */
const addError = (name: string, request: string, code: string) => {
  let threw = false;
  try {
    dispatch(JSON.parse(request) as Request);
  } catch {
    threw = true;
  }
  if (!threw) throw new Error(`expected ${name} to throw in TypeScript`);
  cases.push({
    name,
    request,
    response: JSON.stringify({ ok: false, error: { code } }),
    compare: 'error_code',
  });
};

const pickIndicatorModules = (records: Record<string, unknown[]>) =>
  Object.fromEntries(INDICATOR_KEYS.map((k) => [k, records[k] ?? []])) as Record<string, Json>;

const asJson = (value: unknown) => JSON.parse(JSON.stringify(value)) as Json;

// --- indicators -------------------------------------------------------------------------------

add('indicators/empty', { op: 'indicators', records: asJson(EMPTY) });

// Inputs of apps/api/test/indicators/indicators-domain.test.ts.
const testActor = {
  _id: 'a1',
  Influencia: 'Alta',
  Posicion_Proyecto: 'Crítica',
  Capacidad_Movilizacion: 'Alta',
  'Legitimidad/Representacion': 'Por validar',
};
add('indicators/domain-test-actor', {
  op: 'indicators',
  records: asJson({ ...EMPTY, Actores: [testActor] }),
});
const textRules = {
  ...EMPTY,
  Demandas: [
    { Estado: 'Abierta', Recurrencia: 'Alta', Dimension: 'E - Ambiental', Tema: 'Agua' },
    { Estado: 'Cerrada', Recurrencia: 'Baja', Tema: 'Empleo' },
  ],
  Alertas: [{ ID_Alerta: 'AL-1', Dimension: 'I', Estado: 'Activa', Responsable: 'Por asignar' }],
  Acciones: [{ ID_Alerta: 'AL-1', Estado: 'Pendiente', Evidencia: 'acta' }],
};
add('indicators/domain-test-text-rules', { op: 'indicators', records: asJson(textRules) });
add('indicators/python-parity', { op: 'indicators', records: asJson(parity.records) });

// Benchmark synthetic records (apps/api/bench/synthetic.ts); extra modules must be ignored.
add('indicators/synthetic-1x-seed42-all-modules', {
  op: 'indicators',
  records: asJson(syntheticRecords(1, 42)),
});
// More synthetic seeds and scales run through the irsa cases below (they embed the full report).

// Python semantics on unusual JSON values: numbers, booleans, objects, arrays, null and -0.
const coercion = {
  ...EMPTY,
  Actores: [
    { Tipo_Actor: { b: 1, 2: 'x', 1: true, a: [1.5, null] }, 'Legitimidad/Representacion': 'Fragmentada' },
    { Tipo_Actor: 'Comunal', 'Legitimidad/Representacion': ['limitada'], Influencia: 'ALTA', Posicion_Proyecto: 'No determinado' },
    { Tipo_Actor: 'represent', Influencia: true, Capacidad_Movilizacion: 'media-alta' },
  ],
  Eventos: [
    { Actor_Principal: 12, Dimension_Principal: 0, Dimension_Secundaria: 'gobernanza', Relevancia_Preliminar: 'CRÍTICA' },
    { Actor_Principal: 12.0, Descripcion_Hecho: { texto: 'disputa' }, Territorio: 1e21 },
    { Actor_Principal: false, Descripcion_Hecho: 1e-7, Territorio: 0.000001, Nivel_Verificacion: 'A - verificado' },
    { Actor_Principal: '  ', Territorio: ' Sector ', Dimension_Principal: '﻿E' },
    { Actor_Principal: null, Territorio: 'SECTOR', Dimension_Principal: '  i ' },
  ],
  Demandas: [
    { Estado: ' CERRADA ', Recurrencia: 'alta', Tema: 'Pozo Hierba Blanca' },
    { Estado: 0, Entidad_Competente: 'Según etapa', Dimension: 'territorial' },
    { Estado: '', Tema: 'ΣΑΣ', Descripcion: 'İstanbul' },
  ],
  Alertas: [
    { ID_Alerta: '', _id: 'ALR-x', Dimension: 'Institucional', Estado: 'activa', Responsable: '   ' },
    { Dimension: 'I', Estado: 'Atendida' },
    { ID_Alerta: 0, Dimension: 'I', Estado: null },
  ],
  Acciones: [
    { ID_Alerta: 'ALR-x', Estado: 'En curso' },
    { ID_Alerta: 'None', Estado: 'Vencida' },
    { Estado: 'pendiente', Evidencia_Cierre: 'acta' },
  ],
  Narrativas: [
    { Tema: 'Agua', Tono: 'Negativo', Intensidad: 'Alta', Nivel_Verificacion: 'E - no verificada' },
    { Tema: ' agua ', Estado: 'Cerrada', Nivel_Verificacion: 'D - Opinión' },
    { Tema: true, Descripcion: 'controversia', Estado: 'Activa' },
  ],
  Directorio_Territorial: [
    { 'Sección territorial': '', 'Lugar / ámbito': 'Sector' },
    { 'Sección territorial': 'Sector' },
    { 'Lugar / ámbito': 0 },
  ],
};
add('indicators/python-coercion', { op: 'indicators', records: asJson(coercion) });
// Raw text: -0, exponent spellings and a duplicated key (the last value wins, the first position stays).
addText(
  'indicators/raw-number-spellings',
  `{"op":"indicators","records":{"Eventos":[{"Actor_Principal":-0,"Territorio":1E2},{"Actor_Principal":"A","Actor_Principal":"B","Territorio":100.0}],"Actores":[],"Demandas":[],"Compromisos":[],"Narrativas":[],"Alertas":[],"Acciones":[],"Directorio_Territorial":[{"Sección territorial":-0.0}]}}`,
);

// I6 coverage at and above 100 % (Python keeps the int 100 in the text).
add('indicators/coverage-full', {
  op: 'indicators',
  records: asJson({
    ...EMPTY,
    Eventos: [{ Territorio: 'A' }, { Territorio: 'B' }],
    Directorio_Territorial: [{ 'Sección territorial': 'A' }],
  }),
});

// Custom metadata: missing entries keep the raw indicator, null fields stay null.
add('indicators/custom-meta', {
  op: 'indicators',
  records: asJson(EMPTY),
  meta: {
    G: [
      { code: 'G1', name: 'Uno', definition: 'Def uno' },
      { code: 'G2', name: null },
      { code: 'G1', name: 'Uno bis', definition: 'gana el último' },
    ],
    A: [],
    Z: [{ code: 'A1', name: 'otra dimensión' }],
  },
});

// --- irsa ---------------------------------------------------------------------------------------

add('irsa/empty-default-config', { op: 'irsa', records: asJson(EMPTY) });
add('irsa/python-parity-default-config', { op: 'irsa', records: asJson(parity.records) });
for (const seed of [7, 2026]) {
  add(`irsa/synthetic-1x-seed${seed}`, {
    op: 'irsa',
    records: pickIndicatorModules(syntheticRecords(1, seed)),
  });
}
add('irsa/synthetic-3x-seed11-phase-weights', {
  op: 'irsa',
  records: pickIndicatorModules(syntheticRecords(3, 11)),
  config: asJson({
    ...DEFAULT_IRSA_CONFIG,
    weights: { G: 0.3, A: 0.25, D: 0.15, N: 0.1, E: 0.1, I: 0.1 },
  }),
});

/** apps/api/test/indicators: a minimal report with chosen dimension and indicator scores. */
const report = (scores: Record<string, number>, indicatorScores: (number | null)[] = []) => {
  const base = computeIndicators(EMPTY);
  const [template] = base.indicators;
  if (!template) throw new Error('expected indicators');
  const indicators = indicatorScores.map((score, i) => ({
    ...template,
    code: `X${i}`,
    name: `Indicator ${i}`,
    score,
  }));
  return asJson({
    ...base,
    dimension_scores: { ...base.dimension_scores, ...scores },
    indicators,
  });
};
add('irsa/domain-test-weights', {
  op: 'irsa',
  config: asJson({ ...DEFAULT_IRSA_CONFIG, weights: { G: 0.5, A: 0.5, D: 0, N: 0, E: 0, I: 0 } }),
  report: report({ G: 33.333, A: 10, I: 0 }),
});
add('irsa/domain-test-drivers', {
  op: 'irsa',
  report: report({}, [null, ...Array.from({ length: 20 }, (_, i) => i * 5)]),
});
// Stable sort on equal points and rounding of driver points (ties to even).
add('irsa/driver-ties-and-rounding', {
  op: 'irsa',
  report: report({ G: 0.125, A: 2.675 }, [10, 0.125, 10, 2.675, 0.375, 10, 99.995, 99.995]),
});
// Weights missing a dimension, null and integer-like threshold keys (enumerated first).
addText(
  'irsa/raw-threshold-key-order',
  `{"op":"irsa","config":{"weights":{"G":1,"A":null},"thresholds":{"Verde":[0,100],"10":[0,100],"2":[0,5]},"contributions":{}},"report":${JSON.stringify(report({ G: 3 }))}}`,
);
// Overflow to Infinity and NaN: Python round keeps them; JSON.stringify writes null; the band falls back.
add('irsa/overflow-infinity', {
  op: 'irsa',
  config: asJson({ ...DEFAULT_IRSA_CONFIG, weights: { G: 1e308, A: 1e308 } }),
  report: report({ G: 100, A: 100 }),
});
add('irsa/overflow-nan', {
  op: 'irsa',
  config: asJson({ ...DEFAULT_IRSA_CONFIG, weights: { G: 1e308, A: -1e308 } }),
  report: report({ G: 100, A: 100 }),
});
addError(
  'irsa/round-beyond-1e21',
  JSON.stringify({
    op: 'irsa',
    config: { ...DEFAULT_IRSA_CONFIG, weights: { G: 1e20 } },
    report: report({ G: 100 }),
  }),
  'unsupported_value',
);
addError(
  'indicators/missing-module',
  JSON.stringify({ op: 'indicators', records: { Eventos: [] } }),
  'invalid_input',
);

// --- irsa_config_patch --------------------------------------------------------------------------

add('patch/weights-out-of-tolerance', { op: 'irsa_config_patch', patch: { weights: { G: 0.9 } } });
add('patch/weights-out-of-tolerance-2', {
  op: 'irsa_config_patch',
  patch: { weights: { G: 0.5, A: 0.53 } },
});
add('patch/domain-test-full', {
  op: 'irsa_config_patch',
  patch: {
    weights: { G: 0.5, A: 0.51, Z: 3 },
    thresholds: { Bajo: [0, 50], Alto: [50.01, 100] },
    contributions: { active_alert: 20, new_rule: 1 },
  },
});
add('patch/tolerance-edges', {
  op: 'irsa_config_patch',
  patch: { weights: { G: 0.98, A: null } },
});
add('patch/empty-and-falsy', {
  op: 'irsa_config_patch',
  patch: { weights: null, thresholds: null, contributions: null },
});
add('patch/empty-weights-object', { op: 'irsa_config_patch', patch: { weights: {} } });
addText(
  'patch/raw-config-key-order',
  `{"op":"irsa_config_patch","config":{"z":1,"5":"five","thresholds":{"b":[0,1]},"weights":{"G":1},"contributions":{"x":1,"3":3}},"patch":{"contributions":{"1":1,"x":2},"weights":{"I":1}}}`,
);
addText(
  'patch/config-without-weights',
  `{"op":"irsa_config_patch","config":{"thresholds":{}},"patch":{"weights":{"G":0.99}}}`,
);

// --- select_band --------------------------------------------------------------------------------

const t = DEFAULT_IRSA_CONFIG.thresholds;
for (const irsa of [0, 30, 74.99, 24.995, 100, 100.0001, -1]) {
  add(`select_band/default-${irsa}`, { op: 'select_band', irsa, thresholds: asJson(t) });
}
add('select_band/first-match', {
  op: 'select_band',
  irsa: 10,
  thresholds: { Primera: [0, 50], Segunda: [0, 100] },
});
add('select_band/overflow', { op: 'select_band', irsa: 120, thresholds: { Verde: [0, 100] } });
addText(
  'select_band/raw-integer-keys-first',
  `{"op":"select_band","irsa":3,"thresholds":{"Verde":[0,100],"7":[0,10],"01":[0,5]}}`,
);

add('defaults', { op: 'defaults' });

// --- scalar helpers -----------------------------------------------------------------------------

/** Deterministic doubles: ties, representation errors and random values in the engine's ranges. */
const random = (() => {
  let seed = 20261103;
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
})();
const roundInputs = [
  0.125, 0.375, 2.675, 83.33333, 0.005, 0.015, 0.025, 1.005, 1.115, 5.554994, 33.335, 99.995, 0.5,
  1.5, 2.5, -0.125, -2.675, 1e-15, 4.35, 1e20, 999999999999999.9, 5e-324, -0, 0,
];
for (let i = 0; i < 2000; i++) roundInputs.push(random() * 200 - 50);
for (let i = 0; i < 1000; i++) roundInputs.push(Math.round(random() * 2e6) / 1000);
for (let i = 0; i < 500; i++) roundInputs.push((Math.round(random() * 20000) + 0.5) / 100);
const pyRoundCases = roundInputs.flatMap((x) => [1, 2].map((d) => [x, d, pyRound(x, d)]));

const numberInputs = [
  0, -0, 1, -1, 0.1, 1e21, 1e-7, 1.5e-7, 123e-20, 1e20, 123456789012345680000, 0.000001, 5e-324,
  1.7976931348623157e308, 2 ** 53, 2 ** 53 + 2, 100, 25, 1 / 3, -2.5e-6,
  // Exact ties between two shortest candidates: ECMAScript picks the even digit.
  1128632177133113.25, 123456789012345683968,
];
for (let i = 0; i < 2000; i++) {
  const mag = Math.floor(random() * 60) - 30;
  // Number("1e…") is correctly rounded on every Node version; V8's `**` is not (it changed between 22 and 26).
  numberInputs.push((random() - 0.5) * Number(`1e${mag}`));
}
const numberCases = numberInputs.map((x) => [x, String(x), pyFloat(x)]);

const fixtures = {
  source:
    'Generated by engines/fixtures/generate.ts from apps/api/src/contexts/indicators/domain on synthetic inputs.',
  python_parity: { records: parity.records, expected: parity.expected },
  py_round: pyRoundCases,
  js_number: numberCases,
  cases,
};

// One entry per line keeps diffs reviewable without pretty-printing megabytes of records.
const lines = (items: readonly unknown[]) => items.map((x) => JSON.stringify(x)).join(',\n');
const out = `{"source":${JSON.stringify(fixtures.source)},
"python_parity":${JSON.stringify(fixtures.python_parity)},
"py_round":[
${lines(fixtures.py_round)}
],
"js_number":[
${lines(fixtures.js_number)}
],
"cases":[
${lines(fixtures.cases)}
]}
`;
const defaults = `${JSON.stringify({ indicator_config: INDICATOR_CONFIG, irsa_config: DEFAULT_IRSA_CONFIG }, null, 2)}\n`;

if (process.argv.includes('--check')) {
  const stale = [
    [FIXTURES, out],
    [DEFAULTS, defaults],
  ].filter(([file, text]) => readFileSync(file ?? '', 'utf8') !== text);
  if (stale.length) {
    console.error(`Stale fixtures: ${stale.map(([f]) => f).join(', ')}. Run node engines/fixtures/generate.ts`);
    process.exit(1);
  }
  console.log(`Fixtures are current (${cases.length} cases).`);
} else {
  writeFileSync(FIXTURES, out);
  writeFileSync(DEFAULTS, defaults);
  console.log(`Wrote ${cases.length} cases to ${FIXTURES}`);
}
