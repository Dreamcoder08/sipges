/**
 * Generates the parity fixtures of the Rust conflict-risk engine (engines/crates/conflict-risk) from
 * the TypeScript engine (apps/api/src/contexts/analytics/domain/conflict-risk). Every input is
 * synthetic: invented localities, actors and records.
 *
 *   node engines/fixtures/conflict-risk.ts          # rewrite engines/fixtures/conflict-risk.json
 *   node engines/fixtures/conflict-risk.ts --check  # fail when the committed fixtures are stale
 *
 * `cases` store the request as raw JSON text (`{records, alerts, irsa, today}`) and `value`,
 * `JSON.stringify(conflictRisk(request))`, which the Rust engine must reproduce byte for byte.
 * `errors` are requests the TypeScript engine cannot answer (it throws, or its result holds a lone
 * UTF-16 surrogate); the Rust engine must refuse them. `collation`, `math` and `mn` pin the
 * runtime pieces the engine depends on: `localeCompare(…, 'es')` signs, `Math.exp`/`Math.log`/
 * `Math.log1p` results and the `\p{Mn}` ranges of this Node.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { prng } from '../../apps/api/bench/synthetic.ts';
import {
  type RiskInput,
  conflictRisk,
} from '../../apps/api/src/contexts/analytics/domain/conflict-risk/index.ts';

const FIXTURES = fileURLToPath(new URL('./conflict-risk.json', import.meta.url));
const TODAY = '2026-11-02';

type Case = { readonly name: string; readonly request: string; readonly value: string };
type ErrorCase = { readonly name: string; readonly request: string; readonly reason: string };
const cases: Case[] = [];
const errors: ErrorCase[] = [];

type Rec = { module: string; id: string; payload: Record<string, unknown>; updatedAt: string | null };
type Alert = RiskInput['alerts'][number];
type Irsa = { ts: string; irsa: number };

const addText = (name: string, request: string) => {
  cases.push({ name, request, value: JSON.stringify(conflictRisk(JSON.parse(request) as RiskInput)) });
};
const add = (
  name: string,
  records: Rec[],
  extra: { alerts?: Alert[]; irsa?: Irsa[]; today?: string } = {},
) =>
  addText(
    name,
    JSON.stringify({
      records,
      alerts: extra.alerts ?? [],
      irsa: extra.irsa ?? [],
      today: extra.today ?? TODAY,
    }),
  );
const addError = (name: string, records: Rec[], reason: string) =>
  errors.push({
    name,
    request: JSON.stringify({ records, alerts: [], irsa: [], today: TODAY }),
    reason,
  });

const addDays = (day: string, days: number) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const ago = (days: number) => addDays(TODAY, -days);

let seq = 0;
const rec = (module: string, payload: Record<string, unknown>, updatedAt: string | null = null): Rec => ({
  module,
  id: `${module.slice(0, 2)}-${++seq}`,
  payload,
  updatedAt,
});
const demand = (territory: string, day: string, extra: Record<string, unknown> = {}) =>
  rec('Demandas', { Territorio: territory, Fecha_Registro: day, Estado: 'Nueva', ...extra });
const narrative = (territory: string, day: string, tono = 'Crítico') =>
  rec('Narrativas', { Territorio: territory, Fecha_Inicio: day, Tono: tono });
const redAlert = (territory: string, day: string, extra: Record<string, unknown> = {}) =>
  rec('Alertas', { Territorio: territory, Fecha: day, Nivel_Preliminar: 'Rojo', Estado: 'Abierta', ...extra });
const territorial = (
  id: string,
  createdAt: string,
  territory: string | null,
  level: string,
  status = 'Nueva',
  reviewedAt: string | null = null,
): Alert => ({ id, createdAt, territory, level, status, reviewedAt });

// --- inputs of apps/api/test/analytics/conflict-risk.test.ts ------------------------------------

addText('empty-input', `{"records":[],"alerts":[],"irsa":[],"today":"${TODAY}"}`);
add('test/no-dated-signals', [rec('Demandas', { Territorio: 'Pampa Alta' })]);
add('single-demand', [demand('Pampa Alta', ago(3))]);
const quiet = [demand('Loma Verde', ago(100))];
const rising = [
  demand('Pampa Alta', ago(60)),
  demand('Pampa Alta', ago(20), { Prioridad: 'Alta' }),
  demand('Pampa Alta', ago(5)),
  narrative('Pampa Alta', ago(10)),
  narrative('Pampa Alta', ago(3)),
  redAlert('Pampa Alta', ago(2)),
];
add('test/rising-before', [...quiet, ...rising.slice(0, 1)]);
add('test/rising-after', [...quiet, ...rising]);
add('test/actors-split', [
  rec('Demandas', {
    'Actor/Grupo': 'Comité de Riego Norte; Ronda Campesina Sur',
    Fecha_Registro: ago(4),
    Estado: 'Nueva',
  }),
  rec('Narrativas', { Actor_Relacionado: 'comite de riego norte', Fecha_Inicio: ago(2), Tono: 'Crítico' }),
]);
add('test/irsa-flat', [demand('Pampa Alta', ago(10))]);
add('test/irsa-rising', [demand('Pampa Alta', ago(10))], {
  irsa: [
    { ts: `${ago(120)}T10:00:00Z`, irsa: 30 },
    { ts: `${ago(1)}T10:00:00Z`, irsa: 70 },
  ],
});
add('test/commitment-fulfilled-after-cutoff', [
  rec(
    'Compromisos',
    { Territorio: 'Pampa Alta', Fecha: ago(120), Fecha_Vencimiento: ago(90), Estado: 'Cumplido' },
    `${ago(30)}T12:00:00Z`,
  ),
]);
{
  const cutoff = ago(90);
  add(
    'test/future-data-after-cutoff',
    [
      demand('Pampa Alta', addDays(cutoff, -10)),
      narrative('Pampa Alta', cutoff),
      demand('Pampa Alta', addDays(cutoff, 1)),
      redAlert('Pampa Alta', addDays(cutoff, 5)),
      narrative('Pampa Alta', addDays(cutoff, 20)),
    ],
    { irsa: [{ ts: `${addDays(cutoff, 3)}T00:00:00Z`, irsa: 90 }] },
  );
}
{
  const records: Rec[] = [];
  for (let l = 0; l < 12; l += 1) {
    const name = `Localidad ${l}`;
    const hot = l < 4;
    for (let day = -730; day <= -1; day += hot ? 9 : 40) records.push(demand(name, addDays(TODAY, day)));
    for (let day = -700; day <= -1; day += hot ? 45 : 400) records.push(redAlert(name, addDays(TODAY, day)));
  }
  add('test/calibrated-long-history', records);
}
add('test/generated-alerts-ignored', [
  rec('Alertas', { Territorio: 'Pampa Alta', Fecha: ago(3), Nivel_Preliminar: 'Rojo', Origen: 'SIPGES' }),
]);

// --- ties and collation of names ------------------------------------------------------------------

add(
  'ties/same-score-names-collate-in-spanish',
  [
    'Ñuñoa',
    'Nuñez',
    'nunez',
    'Ángeles',
    'angeles',
    'Zárate',
    'zarate',
    'Árbol Seco',
    'Arbol-Seco',
    'Arbol seco',
    'Ocho 8',
    'ocho 10',
    'Écija',
    'éclair',
    'Niño',
    'Nino',
    'NIÑO Alto',
    'Ñ',
    'Sector (Norte)',
    'Sector Norte',
    '¿Quién?',
    'Ü-Lagos',
  ].map((t) => demand(t, ago(7))),
);
add('ties/equal-dates-keep-input-order-in-refs', [
  demand('Bajo Piura', ago(5), { Tema: 'Primero' }),
  demand('Bajo Piura', ago(5), { Tema: 'Segundo' }),
  demand('Bajo Piura', ago(5), { Tema: 'Tercero' }),
  demand('Bajo Piura', ago(9), { Tema: 'Antes' }),
  demand('bajo  piura', ago(5), { Tema: 'Cuarto, otro espaciado' }),
  demand('BAJO PIURA', ago(5), { Tema: 'Quinto' }),
  demand('Bajo Piura', ago(5), { Tema: 'Sexto' }),
]);
add('ties/actor-and-locality-same-score', [
  rec('Eventos', { Territorio: 'Mismo', Actor_Principal: 'Mismo', Fecha: ago(2) }),
  rec('Eventos', { Territorio: 'Otro', Actor_Principal: 'Otro', Fecha: ago(2) }),
]);

// --- missing, null and odd fields ---------------------------------------------------------------

add(
  'fields/missing-and-null',
  [
    rec('Demandas', {}),
    rec('Demandas', { Territorio: 'Sin Fecha' }),
    rec('Demandas', { Fecha_Registro: ago(2) }),
    rec('Demandas', { Fecha_Registro: ago(2), Territorio: '   ' }),
    rec('Demandas', { Fecha_Registro: ago(2), Territorio: null, Comunidad: 'Comunidad Uno' }),
    rec('Demandas', { Fecha: ago(3), Localidad: 'Loc Dos', Estado: null, Prioridad: null }),
    rec('Demandas', { Fecha_Registro: '', Fecha: ago(4), Distrito: 'Distrito Tres', Tema: '', Descripcion: 'Desc' }),
    rec('Narrativas', { Fecha_Observacion: ago(5), Territorio: 'Loc Dos' }),
    rec('Narrativas', { Fecha_Inicio: ago(5), Territorio: 'Loc Dos', Tono: null }),
    rec('Alertas', { Fecha: ago(1), Territorio: 'Loc Dos' }),
    rec('Eventos', { Fecha: ago(1), Territorio: 'Loc Dos' }),
    rec('Compromisos', { Territorio: 'Loc Dos' }),
  ],
  {
    alerts: [
      territorial('ta-1', `${ago(1)}T08:00:00Z`, null, 'Alta'),
      territorial('ta-2', `${ago(1)}T08:00:00Z`, '   ', 'Alta'),
      territorial('ta-3', 'no es fecha', 'Loc Dos', 'Alta'),
      territorial('ta-4', `${ago(1)}T08:00:00Z`, ' Loc Dos ', 'Alta', 'Nueva', null),
    ],
  },
);
add('fields/odd-json-values', [
  rec('Demandas', { Territorio: 12, Fecha_Registro: ago(2), Prioridad: ['alta'], Estado: ['cerrado'] }),
  rec('Demandas', { Territorio: 12.5, Fecha_Registro: ago(2), Prioridad: { a: 1 }, Estado: 7 }),
  rec('Demandas', { Territorio: 1e21, Fecha_Registro: ago(2), Prioridad: [' Alta ', null] }),
  rec('Demandas', { Territorio: true, Comunidad: 'Bool Pasa', Fecha_Registro: ago(2), Prioridad: [['ALTA']] }),
  rec('Demandas', { Territorio: { x: 1 }, 'Actor/Grupo': 5, Fecha_Registro: ago(2), Tema: 99 }),
  rec('Narrativas', { Territorio: 'Odd', Fecha_Inicio: ago(2), Tono: ['negativo'] }),
  rec('Narrativas', { Territorio: 'Odd', Fecha_Inicio: ago(2), Tono: { tono: 'hostil' } }),
  rec('Narrativas', { Territorio: 'Odd', Fecha_Inicio: ago(2), Tono: 0 }),
  rec('Alertas', { Territorio: 'Odd', Fecha: ago(2), Estado: ['descartado'], Nivel: 2 }),
  rec('Alertas', { Territorio: 'Odd', Fecha: ago(2), Origen: ['SIPGES'], Nivel_Preliminar: 'naranja' }),
  rec('Alertas', { Territorio: 'Odd', Fecha: ago(2), Origen: ' SIPGES ', Nivel_Preliminar: 'naranja' }),
  rec('Compromisos', { Territorio: 'Odd', Fecha: 20261001, Fecha_Vencimiento: ago(30), Estado: true }),
]);

// --- every module, statuses and severities -------------------------------------------------------

add('modules/every-module-and-unknown', [
  demand('Valle', ago(10)),
  rec('Compromisos', { Territorio: 'Valle', Fecha: ago(40), Fecha_Vencimiento: ago(10), 'Actor/Entidad': 'Junta Vecinal' }),
  narrative('Valle', ago(8)),
  redAlert('Valle', ago(6), { Actor: 'Frente Uno', Actor_Relacionado: 'Frente Dos' }),
  rec('Eventos', { Territorio: 'Valle', Fecha: ago(5), Descripcion_Hecho: 'Paro', Actor_Principal: 'Frente Uno', Nivel_Preliminar: 'Alto' }),
  rec('Otros', { Territorio: 'Valle', Fecha: ago(5) }),
  rec('Actores', { Territorio: 'Valle', Fecha: ago(5) }),
  rec('alertas', { Territorio: 'Valle', Fecha: ago(5) }),
]);
add('modules/severities-and-statuses', [
  ...['Rojo', 'CRÍTICO', 'muy alta', 'Naranja', 'Alta', 'alto', 'Amarillo', 'Verde', '', 'Crítica'].map((n, i) =>
    rec('Alertas', { Territorio: `Sev ${i}`, Fecha: ago(3), Nivel_Preliminar: n, Nivel: 'Rojo' }),
  ),
  rec('Alertas', { Territorio: 'Sev N', Fecha: ago(3), Nivel: 'Naranja' }),
  rec('Alertas', { Territorio: 'Disc 1', Fecha: ago(3), Nivel_Preliminar: 'Rojo', Estado: 'Descartada' }, `${ago(1)}T00:00:00Z`),
  rec('Alertas', { Territorio: 'Disc 2', Fecha: ago(3), Nivel_Preliminar: 'Rojo', Estado: ' DESCARTADO ' }),
  rec('Alertas', { Territorio: 'Disc 3', Fecha: ago(3), Nivel_Preliminar: 'Rojo', Estado: 'descartados' }),
  rec('Alertas', { Territorio: 'Disc 4', Fecha: ago(3), Nivel_Preliminar: 'Rojo', Estado: 'Descartada' }, `${ago(5)}T00:00:00Z`),
  rec('Eventos', { Territorio: 'Ev 1', Fecha: ago(3), Relevancia_Preliminar: 'Muy Alta' }),
  rec('Eventos', { Territorio: 'Ev 2', Fecha: ago(3), Nivel_Preliminar: 'baja', Relevancia_Preliminar: 'Rojo' }),
  rec('Eventos', { Territorio: 'Ev 3', Fecha: ago(3), Tipo_Evento: 'Marcha' }),
  ...['Cumplido', ' cumplida ', 'COMPLETADO', 'Cerrada', 'Atendído', 'resuelta', 'Finalizado', 'Cancelada', 'cancelado', 'Incumplido', 'En curso'].map((estado, i) =>
    demand(`Est ${i}`, ago(20), { Estado: estado }),
  ),
  ...['Cumplido', 'Cancelado', 'Pendiente'].map((estado, i) =>
    rec('Compromisos', { Territorio: `Comp ${i}`, Fecha: ago(60), Fecha_Vencimiento: ago(30), Estado: estado }, i === 0 ? `${ago(10)}T05:00:00-05:00` : null),
  ),
  ...['Crítico', 'NEGATIVA', 'hostil', 'Adverso', 'Neutral', 'positivo'].map((tono, i) => narrative(`Tono ${i}`, ago(4), tono)),
]);
add(
  'alerts/territorial-levels-and-statuses',
  [demand('Ribera', ago(50))],
  {
    alerts: [
      territorial('t1', `${ago(2)}T10:00:00Z`, 'Ribera', 'Alta'),
      territorial('t2', `${ago(2)}T10:00:00Z`, 'Ribera', 'Media'),
      territorial('t3', `${ago(2)}T10:00:00Z`, 'Ribera', 'Baja'),
      territorial('t4', `${ago(2)}T10:00:00Z`, 'Ribera', 'Otra'),
      territorial('t5', `${ago(2)}T10:00:00Z`, 'Cañada', 'ALTA', 'Descartada', `${ago(1)}T09:00:00Z`),
      territorial('t6', `${ago(2)}T10:00:00Z`, 'Cañada', 'alta', 'descartado', null),
      territorial('t7', `${ago(2)}T10:00:00Z`, 'Cañada', 'Alta', 'Revisada', `${ago(1)}T09:00:00Z`),
      territorial('t8', `${ago(200)}T10:00:00Z`, 'Antigua', 'Media'),
      territorial('t9', `${addDays(TODAY, 3)}T10:00:00Z`, 'Futura', 'Alta'),
      territorial('t10', `${ago(2)}T10:00:00Z`, 'Proto', 'constructor'),
      territorial('t11', `${ago(2)}T10:00:00Z`, 'Proto', '__proto__'),
      territorial('t12', `${ago(3)}T10:00:00Z`, 'Proto', 'Media'),
      territorial('t13', `${ago(2)}T10:00:00Z`, 'Proto Dos', 'Media'),
    ],
  },
);

// --- IRSA series ----------------------------------------------------------------------------------

add('irsa/series-edges', [demand('Alto Valle', ago(10)), demand('Bajo Valle', ago(200))], {
  irsa: [
    { ts: `${ago(1)}T10:00:00Z`, irsa: 40 },
    { ts: `${ago(1)}T23:00:00Z`, irsa: 45 },
    { ts: 'no-date', irsa: 99 },
    { ts: `${ago(60)}T00:00:00Z`, irsa: 20 },
    { ts: `${ago(60)}T12:00:00Z`, irsa: 22 },
    { ts: `${ago(30)}T00:00:00Z`, irsa: 10 },
    { ts: `${addDays(TODAY, 1)}T00:00:00Z`, irsa: 100 },
  ],
});
add('irsa/falling-and-negative', [demand('Alto Valle', ago(10))], {
  irsa: [
    { ts: `${ago(100)}T10:00:00Z`, irsa: 80 },
    { ts: `${ago(1)}T10:00:00Z`, irsa: -5 },
  ],
});
add('irsa/fractional-rise', [demand('Alto Valle', ago(10)), narrative('Alto Valle', ago(2))], {
  irsa: [
    { ts: `${ago(95)}T10:00:00Z`, irsa: 33.3333 },
    { ts: `${ago(2)}T10:00:00Z`, irsa: 47.123456 },
  ],
});
add('irsa/huge-values', [demand('Uno', ago(10)), demand('Dos', ago(10))], {
  irsa: [
    { ts: `${ago(95)}T10:00:00Z`, irsa: -1e308 },
    { ts: `${ago(2)}T10:00:00Z`, irsa: 1e308 },
  ],
});

// --- commitments and due dates -------------------------------------------------------------------

add('commitments/due-dates', [
  rec('Compromisos', { Territorio: 'Plazos', Fecha: ago(100), Fecha_Vencimiento: ago(1) }),
  rec('Compromisos', { Territorio: 'Plazos', Fecha: ago(100), Fecha_Vencimiento: TODAY }),
  rec('Compromisos', { Territorio: 'Plazos', Fecha: ago(100), Fecha_Vencimiento: addDays(TODAY, 1) }),
  rec('Compromisos', { Territorio: 'Plazos', Fecha: ago(100), Fecha_Vencimiento: '', Plazo: ago(5) }),
  rec('Compromisos', { Territorio: 'Plazos', Fecha: ago(100), Fecha_Vencimiento: '2026-02-30', Plazo: ago(5) }),
  rec('Compromisos', { Territorio: 'Plazos', Fecha: ago(100), Fecha_Limite: ago(6) }),
  rec('Compromisos', { Territorio: 'Plazos', Fecha: ago(100), Plazo: ago(7) }),
  rec('Compromisos', { Territorio: 'Plazos', Fecha: ago(100), Plazo: `${ago(7)}\n` }),
  rec('Compromisos', { Territorio: 'Plazos', Fecha: ago(100), Fecha_Vencimiento: null, Plazo: ago(8) }),
  rec('Compromisos', { Territorio: 'Plazos', Fecha: ago(100), Fecha_Vencimiento: '0000-01-01' }),
  rec('Compromisos', { Territorio: 'Sin Fecha', Fecha_Vencimiento: ago(20) }),
  rec('Compromisos', { Territorio: 'Sin Fecha', Fecha_Vencimiento: addDays(TODAY, 20) }),
  rec('Compromisos', { Territorio: 'Plazos', Fecha: ago(100), Fecha_Vencimiento: ago(3), Estado: 'Cumplido' }, `${ago(2)}T00:00:00Z`),
  rec('Compromisos', { Territorio: 'Plazos', Fecha: ago(100), Fecha_Vencimiento: ago(3), Estado: 'Cumplido' }, 'basura'),
]);

// --- dates ---------------------------------------------------------------------------------------

add('dates/forms-and-invalid', [
  demand('Fechas', '28/10/2026'),
  demand('Fechas', '1/11/2026'),
  demand('Fechas', '31/04/2026'),
  demand('Fechas', '2026-02-30'),
  demand('Fechas', '2026-10-31T23:59:59-05:00'),
  demand('Fechas', '2026-1-05'),
  demand('Fechas', '123/10/2026'),
  demand('Fechas', '05/1/20261'),
  demand('Fechas', ' 2026-10-30'),
  demand('Fechas', '29/02/2024'),
  demand('Fechas', '29/02/2025'),
  rec('Demandas', { Territorio: 'Fechas', Fecha_Registro: 'mal', Fecha: ago(1) }),
  rec('Demandas', { Territorio: 'Fechas', Fecha_Registro: 20261030 }),
]);
add(
  'dates/year-boundary-today',
  [
    demand('Enero', '2024-12-31'),
    demand('Enero', '2025-01-01'),
    demand('Enero', '2024-10-03'),
    narrative('Enero', '2024-12-02'),
    narrative('Enero', '2024-12-03'),
    rec('Compromisos', { Territorio: 'Enero', Fecha: '2024-06-01', Fecha_Vencimiento: '2024-12-31' }),
  ],
  { today: '2025-01-01' },
);
add('dates/leap-today', [demand('Bisiesto', '2024-02-28'), demand('Bisiesto', '2023-12-01')], {
  today: '2024-02-29',
});
add('dates/rollover-today', [demand('Rollover', '2026-02-27'), demand('Rollover', '2026-03-02')], {
  today: '2026-02-30',
});
add('dates/year-zero', [demand('Antiguo', '0000-02-29'), demand('Antiguo', '0000-01-01')], {
  today: '0000-03-01',
});
add('dates/far-future', [demand('Futuro', '9999-12-01'), redAlert('Futuro', '9999-11-01')], {
  today: '9999-12-31',
});

// --- folding, accents and units --------------------------------------------------------------------

add('units/folding-and-duplicates', [
  rec('Demandas', {
    Territorio: '  San   José\tde Ñaña ',
    'Actor/Grupo': 'Asociación Ñandú;asociacion nandu, ASOCIACIÓN  ÑANDÚ ; X ; ;Y2,Frente İstanbul',
    Fecha_Registro: ago(3),
  }),
  rec('Narrativas', { Territorio: 'san jose de nana', Actor_Relacionado: 'ΣΟΦΟΣ; Ὀδυσσεύς', Fecha_Inicio: ago(2), Tono: 'crítica' }),
  rec('Alertas', { Territorio: 'SAN JOSÉ DE ÑAÑA', Actor: 'Frente İstanbul', Actor_Relacionado: 'Frente İstanbul', Fecha: ago(1), Nivel_Preliminar: 'Rojo' }),
  rec('Eventos', { Territorio: 'Café Central', Actor_Principal: 'café central', Fecha: ago(1) }),
  rec('Eventos', { Territorio: 'Ａｎｃｈｏ', Actor_Principal: 'ﬁnca', Fecha: ago(1) }),
  rec('Eventos', { Territorio: 'Sector Uno', Actor_Principal: 'a; 😀; 😀😀', Fecha: ago(1) }),
  demand('San José de Ñaña', addDays(TODAY, 4)),
]);
add('units/future-spelling-wins-name', [
  demand('PRIMERA ESCRITURA', addDays(TODAY, 10)),
  demand('Primera Escritura', ago(10)),
]);
add('titles/long-and-fallback', [
  demand('Titulos', ago(1), { Tema: 'Á'.repeat(121) }),
  demand('Titulos', ago(1), { Tema: 'b'.repeat(120) }),
  demand('Titulos', ago(1), { Tema: '', Descripcion: `${'ñ'.repeat(115)}😀xyzw` }),
  demand('Titulos', ago(1), { Tema: '  ' }),
  demand('Titulos', ago(1), { Tema: 0 }),
]);

// --- limits --------------------------------------------------------------------------------------

add(
  'limits/more-than-50-units',
  Array.from({ length: 60 }, (_, i) =>
    demand(`Caserío ${String(i).padStart(2, '0')}`, ago(1 + (i % 7)), { 'Actor/Grupo': `Grupo ${i % 55}` }),
  ),
);

// --- generated histories (deterministic PRNG) ----------------------------------------------------

const LOCALITIES = ['Pampa Alta', 'Loma Verde', 'Río Seco', 'Ñaupe', 'Cañaveral', 'El Tablazo', 'Bernal', 'Vice', 'La Unión', 'Sechura Baja', 'Chulliyachi', 'Parachique', 'Becará', 'Mala Vida', 'Puerto Rico', 'Letirá', 'Nuevo Ánimo', 'Tamarindo'];
const ACTORS = ['Frente de Defensa', 'Ronda Campesina', 'Gremio Pesquero', 'Comité de Regantes', 'Asociación de Mujeres', 'Junta Vecinal Ñaupe', 'Sindicato Minero'];
const STATES = ['Nueva', 'En curso', 'Cumplido', 'Cerrada', 'Pendiente', 'Cancelado'];
const LEVELS = ['Rojo', 'Naranja', 'Amarillo', 'Verde', 'Crítico'];
const TONES = ['Crítico', 'Negativo', 'Neutral', 'Positivo', 'Hostil'];

const generated = (seed: number, days: number, density: number, today: string) => {
  const random = prng(seed);
  const pick = <T>(list: readonly T[]) => list[Math.floor(random() * list.length)] as T;
  const records: Rec[] = [];
  const alerts: Alert[] = [];
  const irsa: Irsa[] = [];
  const day = (back: number) => addDays(today, -back);
  for (let back = days; back >= 0; back -= 1) {
    const n = Math.floor(random() * density * 2.2);
    for (let k = 0; k < n; k += 1) {
      const loc = pick(LOCALITIES);
      const hot = LOCALITIES.indexOf(loc) < 5;
      const actor = random() < 0.4 ? pick(ACTORS) : '';
      const d = day(back);
      const updated = random() < 0.5 ? `${addDays(d, Math.floor(random() * 60))}T12:00:00Z` : null;
      const roll = random();
      if (roll < 0.35)
        records.push(
          rec('Demandas', { Territorio: loc, 'Actor/Grupo': actor, Fecha_Registro: random() < 0.1 ? d.split('-').reverse().join('/') : d, Estado: pick(STATES), Prioridad: random() < 0.3 ? 'Alta' : 'Media', Tema: `Demanda ${seq}` }, updated),
        );
      else if (roll < 0.5)
        records.push(
          rec('Compromisos', { Territorio: loc, 'Actor/Entidad': actor, Fecha: d, Fecha_Vencimiento: addDays(d, 15 + Math.floor(random() * 90)), Estado: pick(STATES) }, updated),
        );
      else if (roll < 0.7) records.push(rec('Narrativas', { Territorio: loc, Actor_Relacionado: actor, Fecha_Inicio: d, Tono: pick(TONES) }));
      else if (roll < 0.85 && (hot || random() < 0.3))
        records.push(
          rec('Alertas', { Territorio: loc, Actor: actor, Fecha: d, Nivel_Preliminar: pick(LEVELS), Estado: random() < 0.15 ? 'Descartada' : 'Abierta', Causa: `Causa ${seq}` }, updated),
        );
      else if (roll < 0.93)
        records.push(rec('Eventos', { Territorio: loc, Actor_Principal: actor, Fecha: d, Nivel_Preliminar: hot && random() < 0.5 ? 'Alto' : 'Bajo', Descripcion_Hecho: `Hecho ${seq}` }));
      else
        alerts.push(
          territorial(`ta-${seed}-${alerts.length}`, `${d}T${String(Math.floor(random() * 24)).padStart(2, '0')}:00:00Z`, random() < 0.05 ? null : loc, pick(['Alta', 'Media', 'Baja']), random() < 0.2 ? 'Descartada' : 'Nueva', random() < 0.5 ? `${addDays(d, 3)}T00:00:00Z` : null),
        );
    }
    if (back % 7 === 0) irsa.push({ ts: `${day(back)}T06:00:00Z`, irsa: Math.round(random() * 1000) / 10 });
  }
  return { records, alerts, irsa, today };
};
for (const [seed, days, density] of [
  [42, 760, 1.6],
  [7, 900, 2.4],
  [1234, 400, 1],
  [99, 120, 3],
] as const) {
  const g = generated(seed, days, density, TODAY);
  addText(`generated/seed${seed}-${days}d`, JSON.stringify(g));
}
{
  const g = generated(5, 800, 2, '2025-03-01');
  addText('generated/seed5-other-today', JSON.stringify({ ...g, irsa: [] }));
}

// --- requests the TypeScript engine cannot answer --------------------------------------------------

for (const module of ['constructor', '__proto__', 'toString', 'hasOwnProperty'])
  addError(`prototype-module/${module}`, [rec(module, { Territorio: 'X', Fecha: ago(1) })], 'TypeError: spec.dates is not iterable');
addError(
  'lone-surrogate-title',
  [demand('Titulos', ago(1), { Tema: `${'a'.repeat(116)}😀😀x` })],
  'title.slice(0, 117) splits a surrogate pair; JSON.stringify writes a lone \\ud83d',
);
for (const e of errors) {
  let threw = false;
  let lone = false;
  try {
    lone = /\\ud[89ab][0-9a-f]{2}(?!\\ud[c-f])/.test(JSON.stringify(conflictRisk(JSON.parse(e.request) as RiskInput)));
  } catch {
    threw = true;
  }
  if (!threw && !lone) throw new Error(`error case ${e.name} is answered by TypeScript`);
}

// --- runtime pins: collation, math and \p{Mn} ------------------------------------------------------

const random = prng(2026);
const ALPHABET = [
  ...' -_,.;:!?¿¡\'"()[]{}@*/\\&#%`^+<=>|~$0123456789',
  ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ',
  ...'abcdeimnosuzñÑáéíóúüÁÉÍÓÚÜàèçãõâêôÿýČčšŠ',
  ...'æÆøØđĐħĦœŒßＡａﬁªº😀ΩЖ東',
  ...'«»°§¶×÷©®€£¢¥¬±µ…·´¨–—',
  'ñ', 'Ñ', 'é', 'ü', 'ṇ̃', 'a͏', 'ộ',
];
const word = () =>
  Array.from({ length: 1 + Math.floor(random() * 6) }, () => ALPHABET[Math.floor(random() * ALPHABET.length)]).join('');
const collation: [string, string, number][] = [];
for (let i = 0; i < 4000; i += 1) {
  const a = word();
  const b = random() < 0.3 ? [...a].reverse().join('') : random() < 0.5 ? a.toUpperCase() : word();
  collation.push([a, b, Math.sign(a.localeCompare(b, 'es'))]);
}
for (const [a, b] of [['ñ', 'ñ'], ['Ñ', 'n'], ['ñ', 'o'], ['ab', 'Ab'], ['a b', 'ab'], ['x', 'x͏'], ['é', 'é']])
  collation.push([a as string, b as string, Math.sign((a as string).localeCompare(b as string, 'es'))]);

const math: { exp: [number, number][]; log: [number, number][]; log1p: [number, number][] } = {
  exp: [],
  log: [],
  log1p: [],
};
for (let days = 0; days <= 4000; days += 1) math.exp.push([-days / 30, Math.exp(-days / 30)]);
for (let i = 0; i < 3000; i += 1) {
  const x = (random() - 0.5) * 60;
  math.exp.push([x, Math.exp(x)], [-x * random(), Math.exp(-x * random())]);
  const p = random();
  const q = p / (1 - p);
  math.log.push([q, Math.log(q)], [random() * 1e6, Math.log(random() * 1e6)]);
  math.log1p.push([i / 2, Math.log1p(i / 2)], [random() * 3, Math.log1p(random() * 3)], [random() * 1e4, Math.log1p(random() * 1e4)]);
}
for (const x of [1, -1, 0.5, 1e-10, -1e-10, 700, -700, 709.7, -745, 0.34657, 1.0397]) math.exp.push([x, Math.exp(x)]);
for (const x of [1, 2, 0.5, 1e-300, 1e300, 1 + 2 ** -52, 1 - 2 ** -53, Math.SQRT2, Math.SQRT1_2]) math.log.push([x, Math.log(x)]);
for (const x of [1e-30, 1e-10, -0.25, -0.3, -0.9, 0.4142, 0.41422, 1e20, 2 ** 53, 1e-6]) math.log1p.push([x, Math.log1p(x)]);
// Every [x, f(x)] is written by JSON.stringify, which round-trips doubles exactly; recomputing
// f(x) from the parsed x keeps the pair consistent.
const pin = (pairs: [number, number][], f: (x: number) => number) =>
  pairs.map(([x]) => [x, f(x)] as [number, number]);
math.exp = pin(math.exp, Math.exp);
math.log = pin(math.log, Math.log);
math.log1p = pin(math.log1p, Math.log1p);

const mn: [number, number][] = [];
{
  const re = /\p{Mn}/u;
  let start = -1;
  for (let cp = 0; cp <= 0x110000; cp += 1) {
    const is = cp < 0x110000 && (cp < 0xd800 || cp > 0xdfff) && re.test(String.fromCodePoint(cp));
    if (is && start < 0) start = cp;
    if (!is && start >= 0) {
      mn.push([start, cp - 1]);
      start = -1;
    }
  }
}

// --- output ----------------------------------------------------------------------------------------

const out = `{"source":"engines/fixtures/conflict-risk.ts","cases":[
${cases.map((x) => JSON.stringify(x)).join(',\n')}
],"errors":[
${errors.map((x) => JSON.stringify(x)).join(',\n')}
],"collation":${JSON.stringify(collation)},
"math":${JSON.stringify(math)},
"mn":${JSON.stringify(mn)}}
`;

if (process.argv.includes('--check')) {
  if (readFileSync(FIXTURES, 'utf8') !== out) {
    console.error(`Stale fixtures: ${FIXTURES}. Run node engines/fixtures/conflict-risk.ts`);
    process.exit(1);
  }
  console.log(`Fixtures are current (${cases.length} cases).`);
} else {
  writeFileSync(FIXTURES, out);
  console.log(`Wrote ${cases.length} cases to ${FIXTURES}`);
}
