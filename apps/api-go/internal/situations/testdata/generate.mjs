// Records the TypeScript situations routes' answers on synthetic inputs, for the Go port's
// parity test (../http/fixtures_test.go). Run from the repository root after changing either side:
//
//   node apps/api-go/internal/situations/testdata/generate.mjs          # rewrites the fixture
//   node apps/api-go/internal/situations/testdata/generate.mjs --check  # exit 1 when it drifted
//
// Every input is synthetic and built from a fixed seed: no real record is read.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { format, resolveConfig } from 'prettier';
import { createSituationsService } from '../../../../api/src/contexts/situations/application/index.ts';
import { fold } from '../../../../api/src/contexts/situations/domain/signals.ts';
import { situationsRoutes } from '../../../../api/src/contexts/situations/http/situations-routes.ts';

const OUT = fileURLToPath(new URL('./fixtures.json', import.meta.url));
const DAY_MS = 86_400_000;

/** mulberry32: a small deterministic generator, so the fixture never changes between runs. */
const random = (seed) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const TOPICS = [
  'Agua',
  'agua potable para el caserío',
  'Empleo local',
  'contratación de mano de obra',
  'Salud',
  'tránsito pesado',
  'ßeta tema',
  'ǆungla',
  '😀 tema con emoji',
  'ΟΔΟΣ ΣΟΦΙΑΣ',
  'contaminación del río',
  '  Medio   ambiente ',
  'paro regional',
  'canon minero',
  'Pesca artesanal',
  'pesca artesanal',
  'İzmir',
  123,
  4.5,
  true,
  null,
  '',
];
const ACTORS = [
  'Comunidad San Pedro',
  'Municipalidad Distrital; Comunidad San Pedro',
  'José Pérez, Ana Ruiz',
  'A',
  'Frente $& de Defensa',
  "Ronda $' campesina",
  'Junta $$ de usuarios',
  'ÁLVARO GÓMEZ',
  'alvaro gomez',
  'Asociación de pescadores, , ;',
  ' Gremio   de mototaxistas ',
  77,
  '',
];
const TERRITORIES = [
  'Sechura',
  'sechura',
  'Vice',
  'Bernal',
  'Parachique',
  'Bellavista de la Unión',
  '',
];
const SEVERITIES = [
  'Alta',
  'Muy alta',
  'Rojo',
  'naranja',
  'baja',
  'Crítico',
  'ALTO',
  'Media',
  '',
  2,
];
const TONES = [
  'Negativo',
  'positivo',
  'crítico',
  'neutral',
  'hostil',
  'Adverso',
  '',
  { x: 1 },
  ['negativo', 'x'],
  5,
];
const PLATFORMS = [
  'Facebook',
  'Radio Sechura',
  'radio sechura',
  '',
  { a: 1 },
  12,
  ['TikTok'],
  '  WhatsApp ',
];
const WORDS = [
  'reunión',
  'bloqueo',
  'agua',
  'polvo',
  'servidumbre',
  'proveedor',
  'posta',
  'asamblea',
  'directiva',
  'amenaza',
  'regalías',
  'convenio',
  'empleo',
  'desagüe',
  'sin',
  'hecho',
  'trabajadores',
  'ríos',
  'Contaminación',
];

const pick = (rand, list) => list[Math.floor(rand() * list.length)];

const iso = (ms) => new Date(ms).toISOString().slice(0, 10);

/** A date field `age` days before today in one of the formats the domain reads (or not). */
const dateValue = (rand, today, age) => {
  const ms = Date.parse(`${today}T00:00:00Z`) - age * DAY_MS;
  const d = new Date(ms);
  const roll = rand();
  if (roll < 0.55) return iso(ms);
  if (roll < 0.7) return `${iso(ms)}T${String(Math.floor(rand() * 24)).padStart(2, '0')}:15:00Z`;
  if (roll < 0.82) return `${d.getUTCDate()}/${d.getUTCMonth() + 1}/${d.getUTCFullYear()}`;
  if (roll < 0.86) return '2026-02-30';
  if (roll < 0.89) return '31/04/2026';
  if (roll < 0.92) return '';
  if (roll < 0.94) return 20260101;
  return undefined;
};

const sentence = (rand, n) =>
  Array.from({ length: n }, () => pick(rand, WORDS)).join(rand() < 0.2 ? '  ' : ' ');

const longText = (rand) => {
  const roll = rand();
  if (roll < 0.1) return `${'x'.repeat(116)}😀 y más texto después del corte`;
  if (roll < 0.2) return 'Descripción '.repeat(12);
  return sentence(rand, 3 + Math.floor(rand() * 8));
};

const MODULES = [
  'Eventos',
  'Demandas',
  'Compromisos',
  'Narrativas',
  'Alertas',
  'Dialogos',
  'Buzon',
];

const record = (rand, module, n, today, maxAge) => {
  const age = Math.floor(rand() * maxAge) - (rand() < 0.05 ? 3 : 0);
  const date = dateValue(rand, today, age);
  const p = {};
  const set = (key, value) => {
    if (value !== undefined) p[key] = value;
  };
  const territory = () => {
    const key = pick(rand, ['Territorio', 'Comunidad', 'Localidad', 'Distrito', 'Territorio']);
    if (rand() < 0.75) set(key, pick(rand, TERRITORIES));
  };
  switch (module) {
    case 'Eventos':
      set('Fecha', date);
      set('Descripcion_Hecho', rand() < 0.85 ? longText(rand) : '');
      set('Tipo_Evento', pick(rand, ['Reunión', 'Protesta', 'bloqueo de vía', '']));
      set('Actor_Principal', pick(rand, ACTORS));
      set('Tema', pick(rand, TOPICS));
      set(rand() < 0.5 ? 'Relevancia_Preliminar' : 'Nivel_Preliminar', pick(rand, SEVERITIES));
      if (rand() < 0.3) set('Observaciones', sentence(rand, 4));
      break;
    case 'Demandas':
      set(rand() < 0.6 ? 'Fecha_Registro' : 'Fecha', date);
      set('Tema', pick(rand, TOPICS));
      set('Descripcion', longText(rand));
      set('Actor/Grupo', pick(rand, ACTORS));
      set('Prioridad', pick(rand, SEVERITIES));
      break;
    case 'Compromisos':
      set('Fecha', date);
      set('Descripcion', longText(rand));
      set(rand() < 0.5 ? 'Actor/Entidad' : 'Responsable', pick(rand, ACTORS));
      set('Tema', pick(rand, TOPICS));
      set('Prioridad', pick(rand, SEVERITIES));
      break;
    case 'Narrativas':
      set(rand() < 0.7 ? 'Fecha_Inicio' : 'Fecha_Observacion', date);
      set('Tema', pick(rand, TOPICS));
      set('Descripcion', longText(rand));
      set('Actor_Relacionado', pick(rand, ACTORS));
      set('Intensidad', pick(rand, SEVERITIES));
      set('Tono', pick(rand, TONES));
      set('Plataforma/Fuente', pick(rand, PLATFORMS));
      break;
    case 'Alertas':
      set('Fecha', date);
      set('Causa', longText(rand));
      set(rand() < 0.5 ? 'Actor' : 'Actor_Relacionado', pick(rand, ACTORS));
      set('Tema', pick(rand, TOPICS));
      set(rand() < 0.5 ? 'Nivel_Preliminar' : 'Nivel', pick(rand, SEVERITIES));
      if (rand() < 0.3) set('Origen', rand() < 0.7 ? 'SIPGES' : ' SIPGES ');
      if (rand() < 0.3) set('Accion_Sugerida', sentence(rand, 3));
      break;
    case 'Dialogos':
      set('Fecha', date);
      set('Proceso', rand() < 0.7 ? `Mesa ${pick(rand, WORDS)}` : '');
      set('Tema', pick(rand, TOPICS));
      set('Participantes', pick(rand, ACTORS));
      if (rand() < 0.5) set('Acuerdo', sentence(rand, 5));
      break;
    default:
      set('Fecha', date);
      set('Asunto', rand() < 0.8 ? sentence(rand, 3) : '');
      set('Descripcion', longText(rand));
      set('Actor_Relacionado', pick(rand, ACTORS));
      set('Tema', pick(rand, TOPICS));
      set('Prioridad', pick(rand, SEVERITIES));
  }
  territory();
  return {
    module,
    id: `${module.slice(0, 2).toUpperCase()}-${String(n).padStart(3, '0')}`,
    payload: p,
  };
};

const lesson = (rand, n, today) => {
  const p = {};
  if (rand() < 0.85) p.Aprendido = sentence(rand, 6);
  p.Fecha = iso(Date.parse(`${today}T00:00:00Z`) - Math.floor(rand() * 400) * DAY_MS);
  if (rand() < 0.6)
    p[pick(rand, ['Territorio', 'Comunidad', 'Localidad', 'Distrito'])] = pick(rand, TERRITORIES);
  if (rand() < 0.5) p.Tema = pick(rand, TOPICS);
  if (rand() < 0.4) p.Actor = pick(rand, ACTORS);
  return { module: 'Lecciones_Territoriales', id: `LEC-${String(n).padStart(3, '0')}`, payload: p };
};

const STORED = [
  null,
  {
    settings: {
      windowDays: 30,
      halfLifeDays: 7,
      thresholds: { Amarillo: 1.5 },
      recommendations: {
        contactar: 'Llamar a {actores} y {actores}: $& $$ $` hoy',
        verificar: 'Revisar',
      },
      levelMeanings: { Rojo: 'Crítica' },
      phase: 'operacion',
      phaseWeights: { operacion: { G: 0.2, A: 0.2, D: 0.2, N: 0.1, E: 0.2, I: 0.1 } },
      externalAi: { enabled: true },
      location: { place: 'Sechura', extent: [-81.2, -6.1, -80.4, -5.2] },
      version4: { enabled: true },
    },
    updated_by: 'parity-admin',
    updated_at: '2026-10-01T15:04:05.123Z',
  },
  {
    settings: {
      windowDays: 365,
      halfLifeDays: 180,
      thresholds: { Amarillo: 3, Naranja: 9, Rojo: 20 },
      phase: null,
      phaseWeights: { cierre: { G: 0.15, A: 0.1, D: 0.25, N: 0.1, E: 0.25, I: 0.15 } },
      externalAi: { enabled: 'yes' },
    },
    updated_by: 'otro',
    updated_at: '2025-01-31T00:00:00.000Z',
  },
  {
    settings: { windowDays: 7, halfLifeDays: 1, recommendations: { reunion: 'Reunión ya' } },
    updated_by: '',
    updated_at: '2026-06-15T10:00:00.999Z',
  },
  {
    settings: {
      windowDays: 120,
      halfLifeDays: 13,
      thresholds: { Amarillo: 0.75, Naranja: 1.25, Rojo: 2.5 },
    },
    updated_by: 'admin',
    updated_at: '2026-11-02T23:59:59.000Z',
  },
];

const NOWS = [
  '2026-11-03T15:00:00.000Z',
  '2026-11-03T04:30:00.000Z', // still 2026-11-02 in Lima
  '2024-02-29T12:00:00.000Z',
  '2026-01-05T05:00:00.000Z', // Lima midnight exactly
  '2026-07-20T20:20:20.020Z',
];

const scenario = async (index) => {
  const rand = random(1000 + index);
  const stored = STORED[index % STORED.length];
  const now = new Date(NOWS[index % NOWS.length]);
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima' }).format(now);
  const windowDays = stored?.settings.windowDays ?? 90;
  const count = 8 + Math.floor(rand() * (index < 4 ? 80 : 40));
  const records = [];
  for (let n = 0; n < count; n += 1) {
    records.push(record(rand, pick(rand, MODULES), n, today, Math.ceil(windowDays * 1.3) + 2));
  }
  // A run of narratives on one topic whose tone turns, so the tone shift (and its rounding of
  // shares such as 12.5 %) is exercised: recent ones in the last sixth of the window.
  const split = Math.max(1, Math.floor(windowDays / 6) - 1);
  const burst = 2 + Math.floor(rand() * 7);
  for (let n = 0; n < burst + 6; n += 1) {
    const recent = n < burst;
    const age = recent
      ? Math.floor(rand() * split)
      : split + 1 + Math.floor(rand() * (windowDays - split - 1));
    records.push({
      module: 'Narrativas',
      id: `NT-${String(n).padStart(3, '0')}`,
      payload: {
        Fecha_Inicio: iso(Date.parse(`${today}T00:00:00Z`) - age * DAY_MS),
        Tema: 'Agua',
        Descripcion: 'Publicación sobre el pozo comunal',
        Tono: recent
          ? pick(rand, ['Negativo', 'crítico', 'neutral'])
          : pick(rand, ['neutral', 'positivo', 'negativo']),
        'Plataforma/Fuente': pick(rand, PLATFORMS),
      },
    });
  }
  for (let n = 0; n < Math.floor(rand() * 8); n += 1) records.push(lesson(rand, n, today));
  // The reader orders by module, then id (PostgreSQL's collation agrees on these ASCII ids).
  records.sort((a, b) =>
    a.module < b.module ? -1 : a.module > b.module ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );

  const service = createSituationsService({
    settings: {
      load: async () =>
        stored && {
          ...stored.settings,
          updatedBy: stored.updated_by,
          updatedAt: new Date(stored.updated_at),
        },
      save: async () => {
        throw new Error('read-only');
      },
    },
    records: { read: async () => records },
    clock: { now: () => now },
  });
  const routes = situationsRoutes(service);
  // The returned app's own class, so this script needs no `hono` import of its own.
  const app = new routes.constructor();
  app.use('*', async (c, next) => {
    c.set('scope', { companyId: 'SIPGES', projectId: 'PRJ-SINTETICO' });
    await next();
  });
  app.route('/', routes);
  const get = async (path) => {
    const response = await app.request(path);
    if (response.status !== 200) throw new Error(`${path}: ${response.status}`);
    return response.json();
  };
  return {
    name: `scenario ${index}`,
    now: now.toISOString(),
    stored,
    records,
    settings: await get('/system/v4/settings'),
    situations: await get('/system/v4/situations'),
  };
};

const FOLD_SAMPLES = [
  'ÁÉÍÓÚ ñandú',
  '  a\t\n b c﻿ ',
  'a\u0085b',
  'ΟΔΟΣ ΣΟΦΙΑΣ',
  'İstanbul',
  'ẞ straße',
  'ǅ ǆ Ǆ',
  'Ⅻ ⓐ',
  '😀 Ñ',
  'é ẹ̀',
  'ﬁ ﬂ',
  'Ω K Å',
  ...TOPICS.filter((t) => typeof t === 'string'),
  ...ACTORS.filter((a) => typeof a === 'string'),
];

/** JavaScript's `0.5 ** (age / halfLife)` for every age of the widest window (365 days). */
const HALF_LIVES = [1, 7, 13, 14, 30, 180];
const powGrid = () =>
  HALF_LIVES.map((half_life) => ({
    half_life,
    values: Array.from({ length: 366 }, (_, age) => 0.5 ** (age / half_life)),
  }));

const scenarios = [];
for (let index = 0; index < 10; index += 1) scenarios.push(await scenario(index));
const fixture = {
  note: 'Generated by generate.mjs from the TypeScript situations routes; synthetic data only.',
  fold: FOLD_SAMPLES.map((input) => ({ input, output: fold(input) })),
  pow: powGrid(),
  scenarios,
};
// Formatted as `pnpm lint` (prettier --check) expects.
const text = await format(JSON.stringify(fixture), {
  ...(await resolveConfig(OUT)),
  filepath: OUT,
});
if (process.argv.includes('--check')) {
  if (readFileSync(OUT, 'utf8') !== text) {
    console.error('fixtures.json is out of date: run generate.mjs');
    process.exit(1);
  }
} else {
  writeFileSync(OUT, text);
}
