/**
 * Generates the parity fixtures of the Rust integrated-analysis engine from the TypeScript engine
 * (apps/api/src/contexts/analytics/domain/integrated.ts). Every input is synthetic.
 *
 *   node engines/fixtures/integrated.ts          # rewrite engines/fixtures/integrated.json
 *   node engines/fixtures/integrated.ts --check  # fail when the committed fixtures are stale
 *
 * Each case stores the request as raw JSON text and `value` as `JSON.stringify` of the TypeScript
 * result, which the Rust engine must reproduce byte for byte.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { syntheticRecords } from '../../apps/api/bench/synthetic.ts';
import { integratedAnalysis } from '../../apps/api/src/contexts/analytics/domain/integrated.ts';
import {
  type RecordsByModule,
  extendedRecords,
} from '../../apps/api/src/contexts/analytics/domain/records.ts';

const FIXTURES = fileURLToPath(new URL('./integrated.json', import.meta.url));
const AT = '2026-10-12T12:00:00Z';

type Request = { records?: RecordsByModule | null; project_id: string; generated_at: string };
type Case = { name: string; request: string; value: string };
const cases: Case[] = [];

const run = (req: Request) =>
  integratedAnalysis(extendedRecords(req.records ?? {}), req.project_id, req.generated_at);

const add = (name: string, req: Request) => {
  const request = JSON.stringify(req);
  cases.push({ name, request, value: JSON.stringify(run(JSON.parse(request) as Request)) });
};

/** Module records as stored: `{id, payload}` with the given payloads. */
const stored = (module: string, payloads: Record<string, unknown>[]) =>
  payloads.map((payload, i) => ({ id: `${module.slice(0, 3).toUpperCase()}-${i}`, payload }));

const synthetic = (scale: number, seed: number): RecordsByModule =>
  Object.fromEntries(
    Object.entries(syntheticRecords(scale, seed)).map(([module, rows]) => [module, stored(module, rows)]),
  );

add('empty', { records: {}, project_id: 'PRJ-SECHURA', generated_at: AT });
add('null-records', { records: null, project_id: 'PRJ-X', generated_at: AT });
add('null-modules', {
  records: {
    Intereses: null,
    Dialogos: [{ id: 'd1', payload: { Estado: 'Abierto', Tema: 'Agua para pesca' } }],
    Oportunidades: null,
  } as unknown as RecordsByModule,
  project_id: 'PRJ-SECHURA',
  generated_at: AT,
});
add('domain-test-shared-terms', {
  records: {
    Intereses: [
      { id: 'i1', payload: { Interes: 'Pesca artesanal', Preocupacion: 'contaminación marina' } },
      { id: 'i2', payload: { Interes: 'Pesca deportiva' } },
    ],
    Oportunidades: [{ id: 'o1', payload: { Oportunidad: 'Contaminacion', Beneficiarios: 'PESCA' } }],
  },
  project_id: 'PRJ-SECHURA',
  generated_at: AT,
});
add('explicit-and-cross-references', {
  records: {
    Hechos_Compartidos: [
      { id: 'h1', payload: { ID_Proceso: 'P1', Asunto: 'agua', Estado: 'Pendiente' } },
      { id: 'h2', payload: { ID_Proceso: ' p1 ', Referencias_ID: 'h1', Estado: 'Validado' } },
    ],
    Dialogos: [{ id: 'd1', payload: { Registros_Relacionados: 'h1, h2', Estado: 'Abierto' } }],
  },
  project_id: 'PRJ-SECHURA',
  generated_at: AT,
});
add('odd-values', {
  records: {
    Intereses: [
      { id: 'i1', payload: { Interes: null, Preocupacion: 42, Estado: true } },
      { id: 'i2', payload: { Interes: { nested: 'agua pesca' }, Preocupacion: ['agua', 'pesca'] } },
      { id: 'i3', payload: { Interes: '﻿ agua pesca \n', _id: 'shadowed' } },
    ],
    Evaluaciones_AARC: [
      { id: 'a1', payload: { reconocimiento: 3, agencia: '', reciprocidad: null, claridad: 'Alta' } },
    ],
  },
  project_id: 'PRJ-ÑANDÚ',
  generated_at: '2026-01-01',
});
for (const [scale, seed] of [
  [1, 42],
  [1, 7],
] as const) {
  add(`synthetic-${scale}x-seed${seed}`, {
    records: synthetic(scale, seed),
    project_id: 'PRJ-SECHURA',
    generated_at: AT,
  });
}

const out = `{"source":"apps/api/src/contexts/analytics/domain/integrated.ts","cases":[
${cases.map((c) => JSON.stringify(c)).join(',\n')}
]}
`;
if (process.argv.includes('--check')) {
  if (readFileSync(FIXTURES, 'utf8') !== out) {
    console.error(`Stale fixtures: ${FIXTURES}. Run node engines/fixtures/integrated.ts`);
    process.exit(1);
  }
  console.log(`Fixtures are current (${cases.length} cases).`);
} else {
  writeFileSync(FIXTURES, out);
  console.log(`Wrote ${cases.length} cases to ${FIXTURES}`);
}
