// Records the TypeScript indicators write routes' answers on synthetic inputs, for the Go port's
// parity test (../http/writes_fixtures_test.go). Run from the repository root after changing
// either side:
//
//   node apps/api-go/internal/indicators/testdata/generate.mjs          # rewrites the fixture
//   node apps/api-go/internal/indicators/testdata/generate.mjs --check  # exit 1 when it drifted
//
// The routes run unchanged on in-memory stores that write what the SQL stores write: the
// configuration as JSON.stringify(config) and each snapshot's scores the same way. Every input
// is synthetic: no real record is read.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { format, resolveConfig } from 'prettier';
import { createIndicatorsService } from '../../../../api/src/contexts/indicators/application/index.ts';
import { indicatorsRoutes } from '../../../../api/src/contexts/indicators/http/indicators-routes.ts';

const OUT = fileURLToPath(new URL('./writes.json', import.meta.url));
const NOW = new Date('2026-11-03T11:00:00.123Z');
const TENANT = 'SIPGES/PRJ-SECHURA';

/** Records of the modules the indicators read; the snapshot's IRSA depends on them. */
const RECORDS = {
  Eventos: [
    {
      _id: 'EV-1',
      Dimension_Principal: 'Gobernanza',
      Relevancia_Preliminar: 'Alta',
      Descripcion_Hecho: 'Conflicto por la representación',
    },
    { _id: 'EV-2', Dimension_Principal: 'Ambiental', Relevancia_Preliminar: 'Crítica' },
  ],
  Actores: [],
  Demandas: [{ _id: 'DE-1', Estado: 'Pendiente', Tema: 'Empleo local', Dimension: 'Económica' }],
  Compromisos: [],
  Narrativas: [],
  Alertas: [{ _id: 'AL-1', Dimension: 'G', Estado: 'Abierta', Nivel: 'Alto' }],
  Acciones: [],
  Directorio_Territorial: [],
};

const STORED = {
  none: null,
  custom:
    '{"version":"0.4-indicators","weights":{"G":0.5,"A":0.1,"D":0.1,"N":0.1,"E":0.1,"I":0.1},' +
    '"thresholds":{"Rojo":[60,100],"Naranja":[40,59.99],"Amarillo":[20,39.99],"Verde":[0,19.99]},' +
    '"contributions":{"active_alert":10,"high_event":4},"extra":"conservado"}',
  indexKeys:
    '{"z":1,"5":"five","weights":{"G":1},"thresholds":{"b":[0,1],"2":[1,2]},"contributions":{"x":1,"3":3}}',
  noContributions: '{"weights":{"G":1},"thresholds":{"V":[0,100]}}',
};

const CONFIG_BODIES = [
  ['empty payload', '{"payload":{}}'],
  [
    'weights summing to one',
    '{"payload":{"weights":{"G":0.3,"A":0.1,"D":0.2,"N":0.1,"E":0.2,"I":0.1}}}',
  ],
  ['weights within the tolerance', '{"payload":{"weights":{"G":0.98}}}'],
  ['weights outside the tolerance', '{"payload":{"weights":{"G":0.9}}}'],
  ['empty weights object', '{"payload":{"weights":{}}}'],
  ['unknown dimension ignored', '{"payload":{"weights":{"G":0.5,"A":0.5,"Z":3}}}'],
  ['negative zero and exponents', '{"payload":{"weights":{"G":-0,"A":1e0,"D":1e-7}}}'],
  [
    'thresholds in their own order',
    '{"payload":{"thresholds":{"Verde":[0,30],"Rojo":[70.5,100],"2":[30,70]}}}',
  ],
  ['empty thresholds', '{"payload":{"thresholds":{}}}'],
  [
    'contributions merged',
    '{"payload":{"contributions":{"1":1,"x":2,"active_alert":20,"new_rule":1.5}}}',
  ],
  [
    'every field',
    '{"payload":{"weights":{"I":1},"thresholds":{"Alto":[50.01,100],"Bajo":[0,50]},"contributions":{"high_event":0}},"other":1}',
  ],
  ['duplicate keys', '{"payload":{"contributions":{"z":1,"2":2,"z":3},"weights":{"G":2,"G":1}}}'],
  [
    'proto keys dropped',
    '{"payload":{"weights":{"__proto__":0.5,"G":1},"thresholds":{"__proto__":[0,1],"x":[1,2]}}}',
  ],
  [
    'extra payload keys ignored',
    '{"payload":{"version":"x","weights":{"G":1},"project_id":"SIPGES/PRJ-SECHURA"}}',
  ],
  [
    'big numbers',
    '{"payload":{"contributions":{"a":1e21,"b":123456789012345680000,"c":0.000001,"d":1e-7}}}',
  ],
  ['with a BOM', '﻿{"payload":{"weights":{"G":1}}}'],
  ['not JSON', '{"payload":'],
  ['empty body', ''],
  ['trailing data', '{"payload":{}} {}'],
  ['an array', '[1]'],
  ['a number', '1'],
  ['null', 'null'],
  ['a string', '"x"'],
  ['no payload', '{}'],
  ['payload null', '{"payload":null}'],
  ['payload array', '{"payload":[]}'],
  ['payload string', '{"payload":"x"}'],
  [
    'weights of the wrong types',
    '{"payload":{"weights":{"b":"x","1":"y","a":1,"G":true,"A":{},"D":[],"N":null}}}',
  ],
  ['weights infinite', '{"payload":{"weights":{"G":1e400,"A":-1e400}}}'],
  ['records of the wrong types', '{"payload":{"contributions":5,"thresholds":"x","weights":[]}}'],
  ['records null', '{"payload":{"contributions":null,"thresholds":null,"weights":null}}'],
  ['records infinite', '{"payload":{"weights":1e400}}'],
  [
    'bands of the wrong shapes',
    '{"payload":{"thresholds":{"A":[1],"B":[1,2,3],"C":["1",null],"D":{"0":1,"1":2},"E":null,"F":["x"],"G":[1e400,"x",3],"H":[]}}}',
  ],
  ['proto key with a wrong value', '{"payload":{"weights":{"__proto__":"x"}}}'],
  ['issues in shape order', '{"payload":{"contributions":{"a":"1"},"weights":{"G":"1"}}}'],
];

const SNAPSHOT_BODIES = [
  ['empty payload', '{"payload":{}}'],
  ['a note', '{"payload":{"note":"Corte de prueba"}}'],
  ['an empty note', '{"payload":{"note":""}}'],
  ['null note', '{"payload":{"note":null}}'],
  ['false note', '{"payload":{"note":false}}'],
  ['zero note', '{"payload":{"note":0}}'],
  ['negative zero note', '{"payload":{"note":-0}}'],
  ['number note', '{"payload":{"note":1.5e21}}'],
  ['infinite note', '{"payload":{"note":1e400}}'],
  ['true note', '{"payload":{"note":true}}'],
  ['object note', '{"payload":{"note":{"b":1,"2":[true,null],"a":"\\u0000\\n\\"é"}}}'],
  ['array note', '{"payload":{"note":[1,"dos",{"3":3}]}}'],
  ['note with escapes', '{"payload":{"note":"línea\\nnueva \\u2028 😀 \\t"}}'],
  ['extra keys', '{"payload":{"note":"x","project_id":"SIPGES/PRJ-SECHURA"},"x":1}'],
  ['NUL note', '{"payload":{"note":"a\\u0000b"}}'],
  ['NUL inside an array note', '{"payload":{"note":[null,[["x\\u0000"]]]}}'],
  ['not JSON', '{'],
  ['empty body', ''],
  ['an array', '[]'],
  ['no payload', '{"note":"x"}'],
  ['payload null', '{"payload":null}'],
  ['payload array', '{"payload":[]}'],
  ['payload number', '{"payload":1}'],
];

/** The routes over in-memory stores that keep what the SQL stores would write. */
const run = async (path, stored, body, phase) => {
  const state = { config: stored, saved: null, snapshot: null };
  const service = createIndicatorsService({
    records: { read: async () => structuredClone(RECORDS) },
    configs: {
      load: async () => (state.config === null ? null : JSON.parse(state.config)),
      save: async (_tenant, config, at, detail) => {
        state.saved = { config: JSON.stringify(config), at: at.toISOString(), audit: detail };
      },
    },
    snapshots: {
      insert: async (_tenant, s) => {
        state.snapshot = {
          ts: s.ts.toISOString(),
          irsa: s.irsa,
          level: s.level,
          scores: JSON.stringify(s.scores),
          config_version: s.configVersion,
          note: s.note,
          audit: s.auditDetail,
        };
        return 7;
      },
      list: async () => [],
    },
    clock: { now: () => NOW },
    phaseWeights: { forTenant: async () => phase },
  });
  const [companyId, projectId] = TENANT.split('/');
  const routes = indicatorsRoutes({ indicators: service });
  // The returned app's own class, so this script needs no `hono` import of its own.
  const app = new routes.constructor();
  app.use('*', async (c, next) => {
    c.set('scope', { companyId, projectId });
    await next();
  });
  app.route('/', routes);
  const res = await app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
  return {
    status: res.status,
    answer: await res.text(),
    saved: state.saved,
    snapshot: state.snapshot,
  };
};

const PHASE = {
  phase: 'operacion',
  label: 'Operación',
  weights: { G: 0.3, A: 0.1, D: 0.2, N: 0.1, E: 0.2, I: 0.1 },
};

const cases = [];
for (const [storedName, stored] of Object.entries(STORED)) {
  for (const [name, body] of CONFIG_BODIES) {
    cases.push({
      name: `config ${storedName}: ${name}`,
      path: '/system/irsa/config',
      stored,
      request: body,
      ...(await run('/system/irsa/config', stored, body, null)),
    });
  }
}
for (const [storedName, stored] of Object.entries(STORED)) {
  for (const [phaseName, phase] of [
    ['no phase', null],
    ['phase', PHASE],
  ]) {
    const bodies =
      storedName === 'custom' && phaseName === 'no phase'
        ? SNAPSHOT_BODIES
        : SNAPSHOT_BODIES.slice(0, 2);
    for (const [name, body] of bodies) {
      cases.push({
        name: `snapshot ${storedName}, ${phaseName}: ${name}`,
        path: '/system/irsa/snapshot',
        stored,
        phase: phase && { id: phase.phase, weights: JSON.stringify(phase.weights) },
        request: body,
        ...(await run('/system/irsa/snapshot', stored, body, phase)),
      });
    }
  }
}

// A snapshot answer carries the whole IRSA: each distinct answer is kept once, in `bodies`.
const bodies = [];
for (const c of cases) {
  if (!bodies.includes(c.answer)) bodies.push(c.answer);
  c.answer = bodies.indexOf(c.answer);
}
const fixture = {
  note: 'Generated by generate.mjs from the TypeScript indicators write routes; synthetic data only.',
  now: NOW.toISOString(),
  records: RECORDS,
  cases,
  bodies,
};
// Formatted as `pnpm lint` (prettier --check) expects.
const text = await format(JSON.stringify(fixture), {
  ...(await resolveConfig(OUT)),
  filepath: OUT,
});
if (process.argv.includes('--check')) {
  if (readFileSync(OUT, 'utf8') !== text) {
    console.error('writes.json is out of date: run generate.mjs');
    process.exit(1);
  }
} else {
  writeFileSync(OUT, text);
}
