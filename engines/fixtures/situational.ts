/**
 * Generates the parity fixtures of the Rust situational engine (engines/crates/situational) from
 * the TypeScript engine (apps/api/src/contexts/analytics/domain/situational.ts). Every input is
 * synthetic.
 *
 *   node engines/fixtures/situational.ts          # rewrite the fixtures
 *   node engines/fixtures/situational.ts --check  # fail when the committed fixtures are stale
 *
 * Each case stores the request as raw JSON text (`{records, project_id, generated_at,
 * tenant_label?}`) and `value`, `JSON.stringify` of the TypeScript result, which the Rust engine
 * must reproduce byte for byte.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { syntheticRecords } from '../../apps/api/bench/synthetic.ts';
import type { RecordsByModule } from '../../apps/api/src/contexts/analytics/domain/records.ts';
import { buildSituational } from '../../apps/api/src/contexts/analytics/domain/situational.ts';

type Case = { readonly name: string; readonly request: string; readonly value: string };

const FIXTURES = fileURLToPath(new URL('./situational.json', import.meta.url));
const AT = '2026-10-12T12:00:00Z';

const cases: Case[] = [];

/** Reference implementation of the engine request over the TypeScript function. */
const run = (req: {
  records?: RecordsByModule | null;
  project_id: string;
  generated_at: string;
  tenant_label?: string | null;
}) => buildSituational(req.records ?? {}, req.project_id, req.generated_at, req.tenant_label);

/** A case whose request is raw JSON text: key order and number spelling reach the engine as written. */
const addText = (name: string, request: string) => {
  cases.push({ name, request, value: JSON.stringify(run(JSON.parse(request))) });
};

const add = (name: string, req: Record<string, unknown>) => addText(name, JSON.stringify(req));

const rec = (id: string, payload: Record<string, unknown>) => ({ id, payload });

/** `{module: payload[]}` → `{module: [{id: "<MOD>-<i>", payload}]}`. */
const wrap = (records: Record<string, readonly Record<string, unknown>[]>) =>
  Object.fromEntries(
    Object.entries(records).map(([module, rows]) => [
      module,
      rows.map((payload, i) => rec(`${module.slice(0, 3).toUpperCase()}-${i}`, payload)),
    ]),
  );

// --- synthetic benchmark records ----------------------------------------------------------------

for (const [scale, seed] of [
  [1, 42],
  [1, 7],
  [2, 1234],
  [0.25, 99],
] as const) {
  add(`synthetic-${scale}x-seed${seed}`, {
    records: wrap(syntheticRecords(scale, seed)),
    project_id: 'PRJ-SECHURA',
    generated_at: AT,
  });
}
add('synthetic-1x-other-project-with-label', {
  records: wrap(syntheticRecords(1, 5)),
  project_id: 'PRJ-NORTE',
  generated_at: AT,
  tenant_label: 'Proyecto Norte',
});

// --- inputs of apps/api/test/analytics/situational.test.ts ------------------------------------

add('test/counts-every-record', {
  records: {
    Eventos: [rec('e1', {}), rec('e2', { Proyecto_ID: '' }), rec('e3', { Proyecto_ID: 'PRJ-OTRO' })],
    Fuentes: [rec('f1', { Proyecto_ID: 'PRJ-SECHURA' })],
  },
  project_id: 'PRJ-SECHURA',
  generated_at: AT,
});
add('test/closed-states', {
  records: {
    Alertas: [
      rec('a1', { Estado: ' Cerrada ' }),
      rec('a2', { Estado: 'RESUELTO' }),
      rec('a3', { Estado: 'Abierta' }),
      rec('a4', {}),
    ],
    Demandas: [rec('d1', { Estado: 'descartado' }), rec('d2', { Estado: 'Pendiente' })],
  },
  project_id: 'PRJ-SECHURA',
  generated_at: AT,
});
const territories = ['T9', 'T1', 'T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8'];
add('test/top-8-territories', {
  records: { Eventos: [...territories.map((t, i) => rec(`e${i}`, { Territorio: t })), rec('ex', {})] },
  project_id: 'PRJ-SECHURA',
  generated_at: AT,
});
add('test/missing-values-and-colors', {
  records: {
    Eventos: [rec('e1', { Territorio: '' })],
    Demandas: [rec('d1', {})],
    Alertas: [
      rec('a1', { Nivel_Preliminar: 'Verde' }),
      rec('a2', { Nivel: 'Medio' }),
      rec('a3', { Nivel_Preliminar: 'ROJO' }),
    ],
  },
  project_id: 'PRJ-SECHURA',
  generated_at: AT,
});
const norte = { Proyectos: [rec('p', { Proyecto_ID: 'PRJ-NORTE', Nombre: 'Norte' })] };
add('test/project-record-name', { records: norte, project_id: 'PRJ-NORTE', generated_at: AT });
add('test/empty-unknown-project', { records: {}, project_id: 'PRJ-X', generated_at: AT });
add('test/tenant-label', {
  records: {},
  project_id: 'PRJ-NORTE',
  generated_at: AT,
  tenant_label: 'Proyecto Norte',
});
add('test/project-record-beats-label', {
  records: norte,
  project_id: 'PRJ-NORTE',
  generated_at: AT,
  tenant_label: 'Proyecto Norte',
});
add('test/default-project-beats-label', {
  records: {},
  project_id: 'PRJ-SECHURA',
  generated_at: AT,
  tenant_label: 'Proyecto Sechura (migración)',
});
add('test/narratives', {
  records: { Narrativas: [rec('n1', {})] },
  project_id: 'PRJ-SECHURA',
  generated_at: AT,
});

// --- project name and tenant label edge cases -------------------------------------------------

add('label/null', { records: {}, project_id: 'PRJ-N', generated_at: AT, tenant_label: null });
add('label/empty-string', { records: {}, project_id: 'PRJ-N', generated_at: AT, tenant_label: '' });
addText('records/absent', `{"project_id":"PRJ-N","generated_at":"${AT}"}`);
addText('records/null-and-null-modules', `{"records":{"Eventos":null,"Proyectos":null,"Alertas":[]},"project_id":"PRJ-N","generated_at":"${AT}"}`);
add('project/nombre-null-and-number-id', {
  records: {
    Proyectos: [
      rec('p0', { Proyecto_ID: 7, Nombre: 'numeric id never matches' }),
      rec('p1', { Proyecto_ID: 'PRJ-N', Nombre: null }),
      rec('p2', { Proyecto_ID: 'PRJ-N', Nombre: 'second match ignored' }),
    ],
  },
  project_id: 'PRJ-N',
  generated_at: AT,
  tenant_label: 'unused',
});
add('project/nombre-object', {
  records: { Proyectos: [rec('p', { Proyecto_ID: 'PRJ-N', Nombre: { b: 1, 2: 'x', 1: [true] } })] },
  project_id: 'PRJ-N',
  generated_at: AT,
});
add('project/record-without-nombre', {
  records: { Proyectos: [rec('p', { Proyecto_ID: 'PRJ-SECHURA' })] },
  project_id: 'PRJ-SECHURA',
  generated_at: AT,
});
add('project/record-without-nombre-label', {
  records: { Proyectos: [rec('p', { Proyecto_ID: 'PRJ-N', nombre: 'lowercase key' })] },
  project_id: 'PRJ-N',
  generated_at: AT,
  tenant_label: 'Etiqueta',
});

// --- Python value semantics on unusual JSON values -------------------------------------------

add('coercion/states-and-levels', {
  records: {
    Alertas: [
      rec('a1', { Estado: 0, Nivel_Preliminar: 0, Nivel: 'Bajo', Causa: { z: 1, a: null } }),
      rec('a2', { Estado: null, Nivel_Preliminar: null, Nivel: null }),
      rec('a3', { Estado: false, Nivel_Preliminar: false, Nivel: 0 }),
      rec('a4', { Estado: '﻿cerrado ', Nivel_Preliminar: 'rojo' }),
      rec('a5', { Estado: ['cerrada'], Nivel_Preliminar: ' rojo ' }),
      rec('a6', { Estado: 'CERRADA\n', Nivel_Preliminar: 'Amarillo' }),
      rec('a7', { Estado: 'Pendiente', Nivel_Preliminar: 'NARANJA', Fecha: 20261012, Fuente_ID: 1.5 }),
      rec('a8', { Estado: true, Nivel_Preliminar: true, Accion_Sugerida: [1, 'x', null] }),
      rec('a9', { Estado: 'Resuelta', Nivel_Preliminar: 'rojo' }),
      rec('a10', { Nivel_Preliminar: 'VERDE', Nivel: 'ignored' }),
      rec('a11', { Nivel_Preliminar: '', Nivel: 'Verde' }),
      rec('a12', { Nivel_Preliminar: 'desconocido' }),
      rec('a13', { Nivel_Preliminar: 'naranja' }),
      rec('a14', { Nivel_Preliminar: 'ROJO', Estado: 'activa' }),
    ],
  },
  project_id: 'PRJ-SECHURA',
  generated_at: AT,
});
add('coercion/territories-and-themes', {
  records: {
    Eventos: [
      rec('e1', { Territorio: 0 }),
      rec('e2', { Territorio: 12 }),
      rec('e3', { Territorio: 12.0 }),
      rec('e4', { Territorio: Number('1e21') }),
      rec('e5', { Territorio: 0.000001 }),
      rec('e6', { Territorio: 1e-7 }),
      rec('e7', { Territorio: true }),
      rec('e8', { Territorio: false }),
      rec('e9', { Territorio: null }),
      rec('e10', { Territorio: { b: 1, 10: 2, a: 3 } }),
      rec('e11', { Territorio: [] }),
      rec('e12', { Territorio: {} }),
      rec('e13', { Territorio: ' ' }),
      rec('e14', { Territorio: 'Sector \uFEFF' }),
      rec('e15', { Territorio: 'ΣΑΣ', Descripcion_Hecho: 'İstanbul' }),
    ],
    Demandas: [
      rec('d1', { Tema: 'Agua', Estado: 'Abierta' }),
      rec('d2', { Tema: 'agua', Estado: '' }),
      rec('d3', { Tema: 'Agua' }),
      rec('d4', { Tema: 0 }),
      rec('d5', { Tema: [0] }),
      rec('d6', { Tema: 'Empleo', Estado: 'cerrado' }),
    ],
  },
  project_id: 'PRJ-SECHURA',
  generated_at: AT,
});
addText(
  'coercion/raw-number-spellings',
  `{"records":{"Eventos":[{"id":"e1","payload":{"Territorio":-0,"Fecha":1E2}},{"id":"e2","payload":{"Territorio":"A","Territorio":"B","Fecha":100.0}},{"id":"e3","payload":{"Territorio":-0.0,"Fecha":12345678901234567890}}],"Alertas":[{"id":"a1","payload":{"Estado":-0,"Nivel_Preliminar":1e300}}]},"project_id":"PRJ-SECHURA","generated_at":"${AT}"}`,
);
add('records/payload-id-and-index-keys', {
  records: {
    Actores: [
      rec('ac1', { _id: 'stale', 'Nombre_Actor/Organizacion': 'Org', 2: 'x', Influencia: 'Alta' }),
      rec('ac2', { id: 'payload id', Posicion_Proyecto: 'Neutral', Fuente_Principal: null }),
    ],
  },
  project_id: 'PRJ-SECHURA',
  generated_at: AT,
});
add('records/unknown-modules-and-empty-modules', {
  records: {
    Otros: [rec('o1', { Estado: 'Abierta' })],
    Compromisos: [],
    Acciones: [rec('x1', {})],
    Fuentes: [rec('f1', {}), rec('f2', {})],
  },
  project_id: 'PRJ-SECHURA',
  generated_at: AT,
});
add('limits/more-than-8-of-everything', {
  records: {
    Eventos: Array.from({ length: 12 }, (_, i) => rec(`e${i}`, { Territorio: `T${i % 10}`, Fecha: `2026-01-${i}` })),
    Alertas: Array.from({ length: 11 }, (_, i) =>
      rec(`a${i}`, { Nivel_Preliminar: ['verde', 'rojo', 'amarillo', 'naranja', 'otro'][i % 5] }),
    ),
    Demandas: Array.from({ length: 10 }, (_, i) => rec(`d${i}`, { Tema: `Tema ${i % 9}`, Estado: 'Abierta' })),
    Actores: Array.from({ length: 9 }, (_, i) => rec(`ac${i}`, { Influencia: i })),
    Narrativas: Array.from({ length: 3 }, (_, i) => rec(`n${i}`, {})),
  },
  project_id: 'PRJ-SECHURA',
  generated_at: AT,
});
add('strings/unicode-and-escapes', {
  records: {
    Eventos: [rec('e"1\\', { Territorio: 'Línea\nnueva\t"comillas"\u0001', Descripcion_Hecho: '😀 emoji' })],
    Demandas: [rec('d1', { Tema: ' sep ', Estado: 'Ⅻ' })],
  },
  project_id: 'PRJ-ñ',
  generated_at: '',
  tenant_label: 'Ñandú',
});

// --- output -----------------------------------------------------------------------------------

const out = `{"source":"engines/fixtures/situational.ts","cases":[
${cases.map((x) => JSON.stringify(x)).join(',\n')}
]}
`;

if (process.argv.includes('--check')) {
  if (readFileSync(FIXTURES, 'utf8') !== out) {
    console.error(`Stale fixtures: ${FIXTURES}. Run node engines/fixtures/situational.ts`);
    process.exit(1);
  }
  console.log(`Fixtures are current (${cases.length} cases).`);
} else {
  writeFileSync(FIXTURES, out);
  console.log(`Wrote ${cases.length} cases to ${FIXTURES}`);
}
