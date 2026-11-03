/**
 * Generates the parity fixtures of the Rust strategic engine (engines/crates/strategic) from the
 * TypeScript engine (apps/api/src/contexts/analytics/domain/strategic.ts). Every input is synthetic.
 *
 *   node engines/fixtures/strategic.ts          # rewrite the fixtures
 *   node engines/fixtures/strategic.ts --check  # fail when the committed fixtures are stale
 *
 * Each case stores the request as raw JSON text (what the engine parses) and `value`, the
 * `JSON.stringify` of the TypeScript result, which the Rust engine must reproduce byte for byte.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { syntheticRecords } from '../../apps/api/bench/synthetic.ts';
import {
  type RecordsByModule,
  extendedRecords,
} from '../../apps/api/src/contexts/analytics/domain/records.ts';
import { strategicAssessment } from '../../apps/api/src/contexts/analytics/domain/strategic.ts';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Case = { readonly name: string; readonly request: string; readonly value: string };

const FIXTURES = fileURLToPath(new URL('./strategic.json', import.meta.url));
const AT = '2026-10-12T12:00:00Z';
const EXTENDED = ['Intereses', 'Dialogos', 'Oportunidades', 'Hechos_Compartidos', 'Evaluaciones_AARC'];

/** Reference implementation of the engine request over the TypeScript functions. */
const dispatch = (req: { [key: string]: Json }) =>
  strategicAssessment(
    extendedRecords((req.records ?? {}) as unknown as RecordsByModule),
    req.project_id as string,
    req.generated_at as string,
  );

const cases: Case[] = [];
const addText = (name: string, request: string) => {
  const value = JSON.stringify(dispatch(JSON.parse(request) as { [key: string]: Json }));
  cases.push({ name, request, value });
};
const add = (name: string, records: Json, projectId = 'PRJ-SECHURA', generatedAt = AT) =>
  addText(name, JSON.stringify({ records, project_id: projectId, generated_at: generatedAt }));

/** `{module: [{id, payload}]}` from module → payloads. */
const stored = (byModule: Record<string, readonly unknown[]>, only?: readonly string[]) =>
  Object.fromEntries(
    Object.entries(byModule)
      .filter(([module]) => !only || only.includes(module))
      .map(([module, rows]) => [
        module,
        rows.map((payload, i) => ({ id: `${module.slice(0, 3).toUpperCase()}-${i}`, payload })),
      ]),
  ) as Json;
const rows = (module: string, payloads: Json[]) => ({
  [module]: payloads.map((payload, i) => ({ id: `${module.slice(0, 3).toUpperCase()}-${i}`, payload })),
});

const COMPLETE = { Reconocimiento: 'x', Agencia: 'x', Reciprocidad: 'x', Claridad: 'x' };

// Synthetic volumes.
add('synthetic extended and events scale 1 seed 42', stored(syntheticRecords(1, 42), [...EXTENDED, 'Eventos']));
add('synthetic extended scale 1 seed 2026', stored(syntheticRecords(1, 2026), EXTENDED));
add('synthetic extended scale 1 seed 3', stored(syntheticRecords(1, 3), EXTENDED));
add('synthetic extended scale 1 seed 7', stored(syntheticRecords(1, 7), EXTENDED));
add('synthetic extended scale 2 seed 42', stored(syntheticRecords(2, 42), EXTENDED));
add('synthetic extended scale 2 seed 1234', stored(syntheticRecords(2, 1234), EXTENDED));
add('synthetic only facts scale 2 seed 99', stored(syntheticRecords(2, 99), ['Hechos_Compartidos']));

// The existing unit test (apps/api/test/analytics/consensus.test.ts).
add('consensus.test strategic counts', {
  ...rows('Hechos_Compartidos', [{ Estado: 'Validado' }, {}]),
  ...rows('Oportunidades', [{ Estado: 'cerrada' }, {}]),
  ...rows('Dialogos', [{}]),
  ...rows('Evaluaciones_AARC', [COMPLETE, { ...COMPLETE, Claridad: ' ' }]),
});
add('consensus.test empty records', {});
addText('records absent', `{"project_id":"PRJ-X","generated_at":"${AT}"}`);
addText('records null', `{"records":null,"project_id":"PRJ-X","generated_at":"${AT}"}`);
add('empty modules', { Intereses: [], Dialogos: [], Oportunidades: [], Hechos_Compartidos: [], Evaluaciones_AARC: [] });
add('unrelated modules ignored', stored(syntheticRecords(1, 5), ['Eventos', 'Actores']));
add('other project and timestamp', rows('Dialogos', [{ Estado: 'Abierto' }]), 'PRJ-ÑANDÚ 🐍', '');

// States: case, whitespace, non-string values.
add('fact states mixed case', rows('Hechos_Compartidos', [
  { Estado: 'VALIDADO' }, { Estado: 'Cerrado' }, { Estado: 'descartado' }, { Estado: 'Pendiente' },
  { Estado: 'validada' }, { Estado: 'DesCartado' },
]));
add('states with whitespace are not trimmed', rows('Hechos_Compartidos', [
  { Estado: ' validado' }, { Estado: 'validado\n' }, { Estado: '﻿cerrado' }, { Estado: 'cerrado' },
]));
add('fact states non-string', rows('Hechos_Compartidos', [
  { Estado: null }, { Estado: true }, { Estado: false }, { Estado: 0 }, { Estado: 1.5 },
  { Estado: ['validado'] }, { Estado: { a: 'validado' } }, { Estado: 'None' }, { Estado: '' },
]));
add('opportunity states', rows('Oportunidades', [
  { Estado: 'Descartada' }, { Estado: 'DESCARTADO' }, { Estado: 'Cerrada' }, { Estado: 'cerrado' },
  { Estado: 'Abierta' }, { Estado: 'En seguimiento' }, { estado: 'cerrada' },
]));
add('dialogue states', rows('Dialogos', [
  { Estado: 'Cerrado' }, { Estado: 'CERRADA' }, { Estado: 'Finalizado' }, { Estado: 'En curso' },
  { Estado: 'finalizada' },
]));
add('all closed gives no attention', {
  ...rows('Hechos_Compartidos', [{ Estado: 'Validado' }]),
  ...rows('Oportunidades', [{ Estado: 'Cerrada' }]),
  ...rows('Dialogos', [{ Estado: 'Finalizado' }]),
  ...rows('Intereses', [{ Estado: 'Abierto' }, {}]),
});
add('only dialogues open', { ...rows('Dialogos', [{ Estado: 'abierto' }]), ...rows('Hechos_Compartidos', [{ Estado: 'cerrado' }]) });
add('only aarc records', rows('Evaluaciones_AARC', [COMPLETE, COMPLETE, {}]));
add('only opportunities open', rows('Oportunidades', [{ Estado: 'nueva' }]));
add('unicode lowercase states', rows('Hechos_Compartidos', [
  { Estado: 'VALİDADO' }, { Estado: 'ΣΟΦΟΣ' }, { Estado: 'ÉTAT' }, { Estado: 'CERRADO' },
]));

// AARC completeness.
add('aarc partial and complete', rows('Evaluaciones_AARC', [
  COMPLETE,
  { Reconocimiento: 'x', Agencia: 'x', Reciprocidad: 'x' },
  { ...COMPLETE, Agencia: '' },
  { ...COMPLETE, Agencia: '﻿ \t' },
  { ...COMPLETE, Agencia: null },
  { ...COMPLETE, Agencia: 0 },
  { ...COMPLETE, Agencia: false },
  { ...COMPLETE, Agencia: [] },
  { ...COMPLETE, Agencia: {} },
  { reconocimiento: 'x', agencia: 'x', reciprocidad: 'x', claridad: 'x' },
  { Reconocimiento: 3, Agencia: true, Reciprocidad: [1], Claridad: { a: 1 } },
  { Claridad: 'x', Reciprocidad: 'x', Agencia: 'x', Reconocimiento: 'x', Extra: 1 },
]));
addText(
  'raw request with duplicate payload keys and _id in payload',
  `{"generated_at":"${AT}","project_id":"PRJ-SECHURA","records":{"Evaluaciones_AARC":[{"id":"A-1","payload":{"_id":"old","Reconocimiento":"","Reconocimiento":"x","Agencia":"x","Reciprocidad":"x","Claridad":"x"}}],"Hechos_Compartidos":[{"id":"H-1","payload":{"Estado":"validado","Estado":"abierto","1":"x"}}]}}`,
);
addText(
  'raw request with number spellings',
  `{"records":{"Hechos_Compartidos":[{"id":"H-1","payload":{"Estado":1e2}},{"id":"H-2","payload":{"Estado":-0}}],"Evaluaciones_AARC":[{"id":"A-1","payload":{"Reconocimiento":1.0,"Agencia":1e-7,"Reciprocidad":0.0,"Claridad":5}}]},"project_id":"P","generated_at":"G"}`,
);

const out = `{"source":${JSON.stringify(
  'Generated by engines/fixtures/strategic.ts from apps/api/src/contexts/analytics/domain/strategic.ts on synthetic inputs.',
)},
"cases":[
${cases.map((x) => JSON.stringify(x)).join(',\n')}
]}
`;

if (process.argv.includes('--check')) {
  if (readFileSync(FIXTURES, 'utf8') !== out) {
    console.error(`Stale fixtures: ${FIXTURES}. Run node engines/fixtures/strategic.ts`);
    process.exit(1);
  }
  console.log(`Fixtures are current (${cases.length} cases).`);
} else {
  writeFileSync(FIXTURES, out);
  console.log(`Wrote ${cases.length} cases to ${FIXTURES}`);
}
