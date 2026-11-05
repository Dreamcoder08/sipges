// Records what the TypeScript PUT /system/v4/settings answers and saves on synthetic requests, for
// the Go port's pinned test (../application/settings_fixtures_test.go). Each request runs through
// the real situationsRoutes and createSituationsService with a fixed clock and an in-memory store
// that returns the stored settings in jsonb's key order and logs what it would save. Run from the
// repository root after changing either side:
//
//   node apps/api-go/internal/situations/testdata/settings.mjs          # rewrites settings.json
//   node apps/api-go/internal/situations/testdata/settings.mjs --check  # exit 1 when it drifted
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { format, resolveConfig } from 'prettier';
import { createSituationsService } from '../../../../api/src/contexts/situations/application/index.ts';
import { situationsRoutes } from '../../../../api/src/contexts/situations/http/situations-routes.ts';

const OUT = fileURLToPath(new URL('./settings.json', import.meta.url));
const AT = '2026-11-03T12:00:00.123Z';
const BEFORE = '2026-01-01T00:00:00.5Z';
const scope = { companyId: 'SIPGES', projectId: 'PRJ-SINT' };
const J = JSON.stringify;

/** jsonb's key order: shorter keys first, then by bytes; duplicates were already dropped. */
const jsonbOrder = (value) => {
  if (Array.isArray(value)) return value.map(jsonbOrder);
  if (value === null || typeof value !== 'object') return value;
  const size = (k) => Buffer.byteLength(k);
  const keys = Object.keys(value).sort(
    (a, b) => size(a) - size(b) || Buffer.compare(Buffer.from(a), Buffer.from(b)),
  );
  return Object.fromEntries(keys.map((k) => [k, jsonbOrder(value[k])]));
};

const W1 = { G: 0.2, A: 0.2, D: 0.2, N: 0.2, E: 0.1, I: 0.1 };
const W2 = { G: 0.1, A: 0.1, D: 0.2, N: 0.2, E: 0.2, I: 0.2 };
const ROW = {
  windowDays: 60,
  halfLifeDays: 10,
  levelMeanings: { Rojo: 'Crítico sintético' },
  thresholds: { Amarillo: 1, Naranja: 2.5, Rojo: 5 },
  recommendations: { buzon: 'Texto B', verificar: 'Texto V' },
  phase: 'operacion',
  phaseWeights: { exploracion: W1, cierre: W2 },
  externalAi: { enabled: true },
  location: { place: 'Lugar sintético', extent: [-81.5, -6, -80, -5.25] },
  version4: true,
};
const MEANINGS = { Verde: ' Uno ', Amarillo: 'Dos', Naranja: 'Tres', Rojo: 'Cuatro' };
const LOCATION = { place: ' Sechura ', extent: [-81, -6, -80, -5] };

const valid = {
  'nothing to change': [null, '{}'],
  'the same window on no row': [null, J({ window_days: 90 })],
  'unknown keys are dropped': [null, J({ other: 1, project_id: 'PRJ-SINT' })],
  'window on no row': [null, J({ window_days: 30 })],
  'every field': [
    null,
    J({
      level_meanings: MEANINGS,
      window_days: 365,
      half_life_days: 180,
      thresholds: { Amarillo: 0.5, Naranja: 1e-7, Rojo: 1000 },
      recommendations: { contactar: ' Hablar con {actores} ', verificar: 'Mirar' },
      phase: 'construccion',
      phase_weights: { cierre: W1, exploracion: W2 },
      external_ai: { enabled: true },
      location: LOCATION,
    }),
  ],
  'phase alone': [ROW, J({ phase: 'cierre' })],
  'phase cleared': [ROW, J({ phase: null })],
  'phase kept': [ROW, J({ phase: 'operacion' })],
  'location cleared': [ROW, J({ location: null })],
  'location kept': [ROW, J({ location: ROW.location })],
  'no change on a row with two phases still names the weights': [ROW, '{}'],
  'no change on a row with one phase': [{ ...ROW, phaseWeights: { cierre: W2 } }, '{}'],
  'weights kept in their stored key order': [
    { ...ROW, phaseWeights: { cierre: W2 } },
    J({ window_days: 60 }),
  ],
  'the same weights in schema order differ from the stored order': [
    { ...ROW, phaseWeights: { cierre: W2 } },
    J({ phase_weights: { cierre: W2 } }),
  ],
  'a phase weight removed': [ROW, J({ phase_weights: { cierre: null } })],
  'a phase weight added': [ROW, J({ phase_weights: { operacion: W1 } })],
  'an absent phase removed': [
    { ...ROW, phaseWeights: { cierre: W2 } },
    J({ phase_weights: { operacion: null } }),
  ],
  'recommendations replaced': [ROW, J({ recommendations: { inmediata: 'Solo esta' } })],
  'recommendations in another order': [
    ROW,
    J({ recommendations: { verificar: 'Texto V', buzon: 'Texto B' } }),
  ],
  'recommendations cleared': [ROW, J({ recommendations: {} })],
  'meanings over a partial row': [ROW, J({ level_meanings: MEANINGS })],
  'external ai off': [ROW, J({ external_ai: { enabled: false } })],
  'external ai same': [ROW, J({ external_ai: { enabled: true } })],
  'minus zero weight': [
    null,
    '{"phase_weights":{"cierre":{"G":-0,"A":0.2,"D":0.2,"N":0.2,"E":0.2,"I":0.2}}}',
  ],
  'weights near the tolerance': [
    null,
    J({ phase_weights: { cierre: { G: 0.2, A: 0.2, D: 0.2, N: 0.2, E: 0.1, I: 0.08 } } }),
  ],
  'emoji meaning at the limit': [
    null,
    J({ level_meanings: { ...MEANINGS, Verde: '😀'.repeat(120) } }),
  ],
  'a stored string column': ['text', J({ window_days: 20 })],
};

const INVALID = {
  'empty body': '',
  'not JSON': '{',
  'an array': '[]',
  null: 'null',
  'a string': '"x"',
  'wrong types': J({
    level_meanings: 1,
    window_days: 'x',
    half_life_days: true,
    thresholds: [],
    recommendations: [],
    phase: 1,
    phase_weights: 'x',
    external_ai: null,
    location: 1,
  }),
  'null optionals': J({
    level_meanings: null,
    window_days: null,
    half_life_days: null,
    thresholds: null,
    recommendations: null,
    phase_weights: null,
    external_ai: null,
  }),
  'meanings missing': J({ level_meanings: {} }),
  'meanings of the wrong type': J({ level_meanings: { ...MEANINGS, Verde: 1, Rojo: null } }),
  'blank meaning': J({ level_meanings: { ...MEANINGS, Verde: '   ' } }),
  'long meaning': J({ level_meanings: { ...MEANINGS, Verde: 'x'.repeat(121) } }),
  'NUL meaning': J({ level_meanings: { ...MEANINGS, Verde: 'a\0b' } }),
  'long NUL meaning': J({ level_meanings: { ...MEANINGS, Verde: `${'x'.repeat(121)}\0` } }),
  'blank NUL meaning': J({ level_meanings: { ...MEANINGS, Verde: ' \0 ' } }),
  'meanings as arrays': J({ level_meanings: { ...MEANINGS, Verde: [], Rojo: ['a'] } }),
  'window bounds': J({ window_days: 6, half_life_days: 0 }),
  'window bounds high': J({ window_days: 366, half_life_days: 181 }),
  'fractional window': J({ window_days: 7.5 }),
  'infinite window': '{"window_days":1e400}',
  'negative infinite window': '{"window_days":-1e400}',
  'huge window': '{"window_days":1e20}',
  'huge negative half life': '{"half_life_days":-1e20}',
  'thresholds missing': J({ thresholds: {} }),
  'thresholds partly missing': J({ thresholds: { Amarillo: 1 } }),
  'thresholds not positive': J({ thresholds: { Amarillo: 0, Naranja: -1, Rojo: 2 } }),
  'thresholds too big': J({ thresholds: { Amarillo: 1, Naranja: 2, Rojo: 1001 } }),
  'thresholds not rising': J({ thresholds: { Amarillo: 3, Naranja: 2, Rojo: 1 } }),
  'thresholds equal': J({ thresholds: { Amarillo: 1, Naranja: 1, Rojo: 2 } }),
  'thresholds too big and not rising': J({ thresholds: { Amarillo: 2000, Naranja: 2, Rojo: 3 } }),
  'thresholds wrong type stops the refinement': J({
    thresholds: { Amarillo: 'x', Naranja: 2, Rojo: 1 },
  }),
  'infinite threshold': '{"thresholds":{"Amarillo":1,"Naranja":2,"Rojo":1e400}}',
  'unknown recommendation': J({ recommendations: { otra: 'x', verificar: 'y', nueva: 'z' } }),
  'recommendation of the wrong type': J({ recommendations: { verificar: 1, buzon: null } }),
  'blank recommendation': J({ recommendations: { verificar: '  ' } }),
  'long recommendation': J({ recommendations: { verificar: 'x'.repeat(301) } }),
  'NUL recommendation': J({ recommendations: { verificar: '\0' } }),
  'array index key first': '{"recommendations":{"otra":"x","1":"y","verificar":2}}',
  'proto key is skipped': '{"recommendations":{"__proto__":"x"}}',
  'unknown phase': J({ phase: 'otra' }),
  'empty phase': J({ phase: '' }),
  'unknown weight phase': J({ phase_weights: { otra: W1, cierre: null } }),
  'weights missing': J({ phase_weights: { cierre: {} } }),
  'weights of the wrong type': J({ phase_weights: { cierre: 1, operacion: [] } }),
  'weights out of range': J({ phase_weights: { cierre: { ...W1, G: 1.2, A: -0.2 } } }),
  'weights not summing': J({ phase_weights: { cierre: { ...W1, G: 0.5 } } }),
  'weights just past the tolerance': J({ phase_weights: { cierre: { ...W1, G: 0.23 } } }),
  'weights out of range and not summing': J({ phase_weights: { cierre: { ...W1, G: 2 } } }),
  'infinite weight': '{"phase_weights":{"cierre":{"G":1e400,"A":0,"D":0,"N":0,"E":0,"I":0}}}',
  'external ai wrong': J({ external_ai: { enabled: 1 } }),
  'external ai missing': J({ external_ai: {} }),
  'location empty': J({ location: {} }),
  'location of the wrong type': J({ location: { place: 1, extent: 'x' } }),
  'short place': J({ location: { ...LOCATION, place: ' a ' } }),
  'long place': J({ location: { ...LOCATION, place: 'x'.repeat(81) } }),
  'NUL place': J({ location: { ...LOCATION, place: 'ab\0' } }),
  'extent too long': J({ location: { ...LOCATION, extent: [1, 2, 3, 4, 5] } }),
  'extent three values': J({ location: { ...LOCATION, extent: [-81, -6, -80] } }),
  'extent two values': J({ location: { ...LOCATION, extent: [-81, -6] } }),
  'extent empty': J({ location: { ...LOCATION, extent: [] } }),
  'extent wrong types': J({ location: { ...LOCATION, extent: ['a', null, true, {}] } }),
  'extent out of range': J({ location: { ...LOCATION, extent: [-181, -91, 181, 91] } }),
  'extent reversed': J({ location: { ...LOCATION, extent: [-80, -5, -81, -6] } }),
  'extent out of range and reversed': J({ location: { ...LOCATION, extent: [181, 2, 0, 1] } }),
  'extent wrong type stops the refinement': J({
    location: { ...LOCATION, extent: [1, 2, 'x', 1] },
  }),
  'infinite extent': '{"location":{"place":"Lugar","extent":[1e400,0,1,1]}}',
  'lone surrogate key': '{"recommendations":{"\\ud800":"x"}}',
};

const scenarios = [];
const run = async (name, stored, body) => {
  let saved = null;
  const text = stored === 'text' ? J(jsonbOrder(ROW)) : stored && jsonbOrder(stored);
  const service = createSituationsService({
    settings: {
      load: async () =>
        text && {
          ...(typeof text === 'string' ? JSON.parse(text) : text),
          updatedBy: 'antes',
          updatedAt: new Date(BEFORE),
        },
      save: async (_tenant, settings, detail) => {
        const { updatedBy, updatedAt, ...rest } = settings;
        saved = { settings: J(rest), updatedBy, updatedAt: updatedAt.toISOString(), detail };
      },
    },
    records: { read: async () => [] },
    clock: { now: () => new Date(AT) },
  });
  const routes = situationsRoutes(service);
  const app = new routes.constructor();
  app.use('*', async (c, next) => {
    c.set('scope', scope);
    c.set('identity', { username: 'sint.admin' });
    await next();
  });
  app.route('/', routes);
  const response = await app.request('/system/v4/settings', {
    method: 'PUT',
    body,
    headers: { 'content-type': 'application/json' },
  });
  scenarios.push({
    name,
    stored: text ? (typeof text === 'string' ? text : J(text)) : null,
    body,
    status: response.status,
    response: await response.text(),
    saved,
  });
};

for (const [name, [stored, body]] of Object.entries(valid)) await run(name, stored, body);
for (const [name, body] of Object.entries(INVALID)) await run(name, null, body);

// Formatted as `pnpm lint` (prettier --check) expects.
const text = await format(JSON.stringify({ at: AT, before: BEFORE, scenarios }), {
  ...(await resolveConfig(OUT)),
  filepath: OUT,
});
if (process.argv.includes('--check')) {
  if (readFileSync(OUT, 'utf8') !== text) {
    console.error('settings.json drifted: rerun without --check');
    process.exit(1);
  }
} else writeFileSync(OUT, text);
