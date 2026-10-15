import type { ModuleRecord } from '@mascli/contracts';
import { type DimensionCode, dimensionOf, foldText } from '../../shared/lib/text.ts';

/** Series of the narrative trend chart, in legend order. */
export const TREND_SERIES: readonly { code: DimensionCode; label: string }[] = [
  { code: 'E', label: 'Medio ambiente' },
  { code: 'G', label: 'Gobernanza' },
  { code: 'D', label: 'Demandas y compromisos' },
  { code: 'A', label: 'Actores e influencia' },
  { code: 'N', label: 'Narrativas y señales digitales' },
  { code: 'I', label: 'Institucional y trazabilidad' },
];

/**
 * Topic words per category, matched on the folded topic and description of a narrative.
 * Channel words (Facebook, prensa…) are left out on purpose: every narrative is a digital
 * signal, so they would put all of them in N. A narrative with no topic words stays in N.
 */
const TOPIC_WORDS: Readonly<Record<Exclude<DimensionCode, 'N'>, readonly string[]>> = {
  E: [
    'ambient',
    'agua',
    'pesca',
    'pescador',
    'maricultura',
    'bahia',
    'playa',
    'manglar',
    'estuario',
    'contamina',
    'derrame',
    'biodiversidad',
    'pozo',
    'ganad',
    'agricult',
    'territori',
    'salud',
    'residuo',
    'fosfat',
    'mineri',
  ],
  G: [
    'gobernanza',
    'representacion',
    'junta',
    'directiva',
    'eleccion',
    'padron',
    'comunal',
    'administrador judicial',
    'asamblea',
    'dirigencia',
    'legitimidad',
    'alcald',
  ],
  D: [
    'demanda',
    'solicit',
    'compromiso',
    'empleo',
    'trabajo',
    'proveedor',
    'beneficio',
    'capacitacion',
    'reclamo',
    'exige',
    'exigen',
    'canon',
    'compensacion',
    'acuerdo',
  ],
  A: [
    'actor',
    'alianza',
    'liderazgo',
    'lider',
    'influencia',
    'movilizacion',
    'organizacion',
    'gremio',
    'sindicato',
    'asociacion',
  ],
  I: [
    'institucional',
    'municipalidad',
    'ministerio',
    'minem',
    'proinversion',
    'oficio',
    'resolucion',
    'subprefectura',
    'gobierno regional',
    'trazabilidad',
    'adjudicacion',
  ],
};
const INFERRED = ['E', 'G', 'D', 'A', 'I'] as const;

/** The narrative's category: its «Categoría» field, else inferred from topic and description. */
export const narrativeCategory = (record: ModuleRecord): DimensionCode => {
  const explicit = dimensionOf(record['Categoria']);
  if (explicit) return explicit;
  const topic = foldText(record['Tema']);
  const text = `${topic} ${topic} ${foldText(record['Descripcion'])}`;
  let best: DimensionCode = 'N';
  let bestScore = 0;
  for (const code of INFERRED) {
    const score = TOPIC_WORDS[code].reduce((sum, word) => sum + (text.split(word).length - 1), 0);
    if (score > bestScore) [best, bestScore] = [code, score];
  }
  return best;
};

/** Publication day (observation day as fallback) as YYYY-MM-DD, or null when unknown. */
export const narrativeDay = (record: ModuleRecord): string | null => {
  for (const key of ['Fecha_Inicio', 'Fecha_Observacion']) {
    const value = String(record[key] ?? '').trim();
    const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
    if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
    const local = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(value);
    if (local) return `${local[3]}-${local[2]?.padStart(2, '0')}-${local[1]?.padStart(2, '0')}`;
  }
  return null;
};

const DAY_MS = 86_400_000;
const addDays = (day: string, n: number) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

export type TrendWindow = 30 | 90 | 'todo';

/**
 * Narratives per day and category, with zero-filled days. The window ends on the latest dated
 * narrative so a quiet week does not empty the chart; at least seven days are shown.
 */
export const narrativeTrend = (rows: readonly ModuleRecord[], window: TrendWindow) => {
  const dated = rows.flatMap((row) => {
    const day = narrativeDay(row);
    return day ? [{ day, code: narrativeCategory(row) }] : [];
  });
  const undated = rows.length - dated.length;
  if (!dated.length) return { days: [], series: [], total: 0, undated };
  const sorted = dated.map((d) => d.day).sort();
  const last = sorted[sorted.length - 1] ?? '';
  const first = sorted[0] ?? last;
  const span = window === 'todo' ? Infinity : window;
  let start = first;
  if (Date.parse(last) - Date.parse(first) >= span * DAY_MS) start = addDays(last, 1 - span);
  if (Date.parse(last) - Date.parse(start) < 6 * DAY_MS) start = addDays(last, -6);
  const days: string[] = [];
  for (let day = start; day <= last; day = addDays(day, 1)) days.push(day);
  const index = new Map(days.map((day, i) => [day, i]));
  const counts = Object.fromEntries(
    TREND_SERIES.map(({ code }) => [code, days.map(() => 0)]),
  ) as Record<DimensionCode, number[]>;
  let total = 0;
  for (const { day, code } of dated) {
    const i = index.get(day);
    if (i === undefined) continue;
    counts[code][i] = (counts[code][i] ?? 0) + 1;
    total += 1;
  }
  // The five categories of the methodology always show; I only when it has data.
  const series = TREND_SERIES.filter(({ code }) => code !== 'I' || counts.I.some((n) => n > 0)).map(
    ({ code, label }) => ({ code, label, values: counts[code] }),
  );
  return { days, series, total, undated };
};
