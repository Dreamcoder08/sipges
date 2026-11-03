/**
 * Generates the parity fixtures of the Rust consensus engine (engines/crates/consensus) from the
 * TypeScript engine (apps/api/src/contexts/analytics/domain/consensus.ts). Every input is synthetic.
 *
 *   node engines/fixtures/consensus.ts          # rewrite the fixtures
 *   node engines/fixtures/consensus.ts --check  # fail when the committed fixtures are stale
 *
 * Each case stores the request as raw JSON text (what the engine parses) and `value`, the
 * `JSON.stringify` of `automatedConsensus(extendedRecords(records), project_id, generated_at)`,
 * which the Rust engine must reproduce byte for byte.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { syntheticRecords } from '../../apps/api/bench/synthetic.ts';
import { automatedConsensus } from '../../apps/api/src/contexts/analytics/domain/consensus.ts';
import {
  type RecordsByModule,
  extendedRecords,
} from '../../apps/api/src/contexts/analytics/domain/records.ts';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Payload = { [key: string]: Json };
type Request = { readonly records?: Json; readonly project_id: string; readonly generated_at: string };
type Case = { readonly name: string; readonly request: string; readonly value: string };

const FIXTURES = fileURLToPath(new URL('./consensus.json', import.meta.url));
const AT = '2026-10-12T12:00:00Z';
const EXTENDED = ['Intereses', 'Dialogos', 'Oportunidades', 'Hechos_Compartidos', 'Evaluaciones_AARC'];
const COMPLETE_AARC = { Reconocimiento: 'x', Agencia: 'x', Reciprocidad: 'x', Claridad: 'x' };

const cases: Case[] = [];
const add = (name: string, request: Request) => {
  const records = (request.records ?? {}) as unknown as RecordsByModule;
  const value = automatedConsensus(extendedRecords(records), request.project_id, request.generated_at);
  cases.push({ name, request: JSON.stringify(request), value: JSON.stringify(value) });
};
/** `{module: [{id, payload}]}` from `[id, payload]` pairs. */
const rows = (items: readonly (readonly [string, Payload])[]) =>
  items.map(([id, payload]) => ({ id, payload }));
const req = (records: { [module: string]: ReturnType<typeof rows> }, projectId = 'PRJ-SECHURA') => ({
  records,
  project_id: projectId,
  generated_at: AT,
});

// Synthetic volumes (apps/api/bench/synthetic.ts), extended modules only.
for (const [scale, seed] of [
  [1, 42],
  [1, 7],
  [2, 99],
  [1, 2026],
] as const) {
  const synthetic = syntheticRecords(scale, seed) as unknown as Record<string, Payload[]>;
  const records: { [module: string]: ReturnType<typeof rows> } = {};
  for (const module of EXTENDED) {
    const prefix = module.slice(0, 3).toUpperCase();
    records[module] = rows((synthetic[module] ?? []).map((p, i) => [`${prefix}-${i}`, p] as const));
  }
  add(`synthetic scale ${scale} seed ${seed}`, req(records, `PRJ-SYN-${seed}`));
}

// Inputs of apps/api/test/analytics/consensus.test.ts.
add('test: hechos pending', req({ Hechos_Compartidos: rows([['h1', { Estado: ' Pendiente ' }]]) }));
add(
  'test: hechos validated',
  req({ Hechos_Compartidos: rows([['h2', { Estado: ' VALIDADO ', Fuente_ID: 'F1' }]]) }),
);
add('test: intereses concern', req({ Intereses: rows([['i1', { Actor: 'Gremio', Preocupacion: 'agua' }]]) }));
add('test: intereses empty', req({ Intereses: rows([['i2', {}]]) }));
add('test: dialogos open', req({ Dialogos: rows([['d1', { Responsable: 'Ana' }]]) }));
add('test: dialogos finalizado', req({ Dialogos: rows([['d2', { Estado: 'Finalizado' }]]) }));
add('test: oportunidades viability', req({ Oportunidades: rows([['o1', { Viabilidad: 'alta' }]]) }));
add('test: oportunidades descartada', req({ Oportunidades: rows([['o2', { Estado: 'Descartada' }]]) }));
add(
  'test: aarc missing and evidence',
  req({ Evaluaciones_AARC: rows([['a1', { Agencia: 'x' }], ['a2', COMPLETE_AARC]]) }),
);
add('test: aarc complete', req({ Evaluaciones_AARC: rows([['a3', { ...COMPLETE_AARC, Evidencia: 'acta' }]]) }));
add(
  'test: cross-module',
  req({
    Intereses: rows(['i1', 'i2', 'i3', 'i4'].map((id) => [id, { Interes: 'x', Mandato: 'x' }] as const)),
    Oportunidades: rows([['o1', { Viabilidad: 'x', Restricciones: 'x', Responsable: 'x' }]]),
    Hechos_Compartidos: rows([
      ['h1', { Estado: 'validado', Fuente_ID: 'F' }],
      ['h2', { Estado: 'validado', Fuente_ID: 'F' }],
    ]),
    Dialogos: rows([['d1', { Estado: 'cerrado' }]]),
  }),
);
add(
  'test: dedup',
  req({ Hechos_Compartidos: rows([['h1', { Estado: 'abierto' }], ['h1', { Estado: 'abierto' }]]) }, 'PRJ-NORTE'),
);

// Hand-written edge cases.
add('empty request records', { project_id: 'PRJ-SECHURA', generated_at: AT });
add('null records', { records: null, project_id: '', generated_at: '' });
add('empty modules', req({ Intereses: [], Dialogos: [], Oportunidades: [], Hechos_Compartidos: [], Evaluaciones_AARC: [] }));
add(
  'null, numbers, booleans and objects as values',
  req({
    Hechos_Compartidos: rows([
      ['h-null', { Estado: null, Fuente_ID: null }],
      ['h-num', { Estado: 0, Fuente_ID: 0 }],
      ['h-bool', { Estado: true, Fuente_ID: false }],
      ['h-obj', { Estado: { a: 'validado' }, Fuente_ID: { '2': 1, b: [1.5, null] } }],
      ['h-arr', { Estado: ['validado'], Fuente_ID: [] }],
    ]),
    Intereses: rows([
      ['i-num', { Actor: 12.5, Interes: 0, Mandato: true, Preocupacion: null }],
      ['i-obj', { Actor: { n: 1 }, Interes: {}, Mandato: [], Preocupacion: 1e21, Fuente_ID: '' }],
      ['i-null-actor', { Actor: null, Preocupacion: false }],
    ]),
    Dialogos: rows([['d-null', { Estado: null, Proximo_Paso: 1, Responsable: 2, Fuente_ID: 3 }]]),
    Oportunidades: rows([['o-null', { Estado: null, Viabilidad: null, Restricciones: null, Responsable: null }]]),
    Evaluaciones_AARC: rows([['a-num', { Reconocimiento: 0, Agencia: false, Reciprocidad: null, Claridad: 1 }]]),
  }),
);
add(
  'whitespace and BOM',
  req({
    Hechos_Compartidos: rows([
      ['h-bom', { Estado: '﻿ Validado  ', Fuente_ID: '﻿' }],
      ['h-tab', { Estado: '\tcerrado\n', Fuente_ID: ' F　' }],
      ['h-inner', { Estado: 'des cartado', Fuente_ID: ' ' }],
    ]),
    Intereses: rows([['i-ws', { Actor: '    ', Interes: ' \r\n', Mandato: '​', Preocupacion: '﻿' }]]),
    Dialogos: rows([
      ['d-ws', { Estado: ' cerrado ', Proximo_Paso: 'x', Responsable: 'y' }],
      ['d-bom', { Estado: '﻿cerrada', Proximo_Paso: ' ', Responsable: 'y', Fuente_ID: 'F' }],
    ]),
    Oportunidades: rows([['o-ws', { Estado: ' cerrado', Viabilidad: 'x', Restricciones: '\t', Responsable: ' ' }]]),
    Evaluaciones_AARC: rows([['a-ws', { ...COMPLETE_AARC, Claridad: '﻿', Evidencia: ' ' }]]),
  }),
);
add(
  'case folding of states',
  req({
    Hechos_Compartidos: rows([
      ['h1', { Estado: 'CERRADO', Fuente_ID: 'F' }],
      ['h2', { Estado: 'DESCARTADO', Fuente_ID: 'F' }],
      ['h3', { Estado: 'VALİDADO', Fuente_ID: 'F' }],
      ['h4', { Estado: 'ΣΑΣ', Fuente_ID: 'F' }],
    ]),
    Dialogos: rows([
      ['d1', { Estado: 'FINALIZADO' }],
      ['d2', { Estado: 'CerrADA' }],
      ['d3', { Estado: 'Ünico', Proximo_Paso: 'x', Responsable: 'y', Fuente_ID: 'F' }],
    ]),
    Oportunidades: rows([
      ['o1', { Estado: 'DESCARTADA' }],
      ['o2', { Estado: 'Cerrada' }],
      ['o3', { Estado: 'Abierta', Viabilidad: 'x', Restricciones: 'y', Responsable: 'z' }],
    ]),
  }),
);
add(
  'dedup across records with the same id and ties',
  req({
    Intereses: rows([
      ['i1', { Actor: 'A' }],
      ['i1', { Actor: 'B', Interes: 'x' }],
      ['i2', { Actor: 'C', Interes: 'x', Mandato: 'm', Preocupacion: 'p', Fuente_ID: 'F' }],
    ]),
    Oportunidades: rows([['o1', {}], ['o1', {}], ['o2', { Estado: 'cerrado' }], ['o3', { Responsable: 'r' }]]),
    Evaluaciones_AARC: rows([['a1', {}], ['a1', COMPLETE_AARC], ['a2', COMPLETE_AARC]]),
    Dialogos: rows([['d1', {}], ['d1', { Proximo_Paso: 'x', Responsable: 'y' }]]),
    Hechos_Compartidos: rows([['h1', {}], ['h1', { Estado: 'validado' }]]),
  }),
);
add(
  'cross-module needs both modules',
  req({ Intereses: rows([['i1', { Interes: 'x', Mandato: 'x' }]]), Hechos_Compartidos: rows([['h1', { Estado: 'validado', Fuente_ID: 'F' }]]) }),
);
add(
  'cross-module with closed records and fewer than three',
  req({
    Intereses: rows([['i1', { Interes: 'x', Mandato: 'x' }], ['i2', { Interes: 'x', Mandato: 'x' }]]),
    Oportunidades: rows([
      ['o1', { Estado: 'cerrada' }],
      ['o2', { Estado: 'cerrada' }],
      ['o3', { Estado: 'cerrada' }],
      ['o4', { Estado: 'cerrada' }],
    ]),
    Hechos_Compartidos: rows([['h1', { Estado: 'validado', Fuente_ID: 'F' }]]),
    Dialogos: rows([['d1', { Estado: 'cerrado' }], ['d2', {}]]),
  }),
);
add(
  'every card kind and priority',
  req(
    {
      Hechos_Compartidos: rows([['H-1', {}]]),
      Intereses: rows([['I-1', { Preocupacion: 'p' }]]),
      Dialogos: rows([['D-1', {}]]),
      Oportunidades: rows([['O-1', {}]]),
      Evaluaciones_AARC: rows([['A-1', {}], ['A-2', COMPLETE_AARC]]),
    },
    'PRJ-ÑANDÚ',
  ),
);
add(
  'unicode ids, empty ids and payload _id',
  req({
    Hechos_Compartidos: rows([['', { _id: 'shadow' }], ['😀-ñ', { Estado: 'x' }]]),
    Intereses: rows([['', { Actor: '' }], ['i\u0000"\\', { _id: 9, Actor: '"q"' }]]),
    Oportunidades: rows([['o"\n', {}]]),
    Dialogos: rows([['</script>', {}]]),
  }),
);
add(
  'numeric-like payload keys and extra modules',
  req({
    Intereses: rows([['i1', { '10': 'a', '2': 'b', Actor: 'X', Interes: 'i', Mandato: 'm' }]]),
    Evaluaciones_AARC: rows([['a1', { '1': 1, Reconocimiento: 'r', Agencia: 'a', Reciprocidad: 'r', Claridad: 'c', Evidencia: 'e' }]]),
    Eventos: rows([['e1', { Estado: 'x' }]]),
    Hechos: rows([['ignored', {}]]),
  }),
);
add('long project and timestamp text', {
  records: {},
  project_id: `PRJ-${'X'.repeat(300)}`,
  generated_at: '2026-11-03T00:00:00.000+05:30',
});

const out = `{"source":${JSON.stringify(
  'Generated by engines/fixtures/consensus.ts from apps/api/src/contexts/analytics/domain/consensus.ts on synthetic inputs.',
)},
"cases":[
${cases.map((c) => JSON.stringify(c)).join(',\n')}
]}
`;

if (process.argv.includes('--check')) {
  if (readFileSync(FIXTURES, 'utf8') !== out) {
    console.error(`Stale fixtures: ${FIXTURES}. Run node engines/fixtures/consensus.ts`);
    process.exit(1);
  }
  console.log(`Fixtures are current (${cases.length} cases).`);
} else {
  writeFileSync(FIXTURES, out);
  console.log(`Wrote ${cases.length} cases to ${FIXTURES}`);
}
