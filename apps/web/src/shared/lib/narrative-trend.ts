import type { ModuleRecord } from '@sipges/contracts';
import { type DimensionCode, dimensionOf, foldText } from './text.ts';

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

const MONTHS: Readonly<Record<string, number>> = {
  ene: 1,
  feb: 2,
  mar: 3,
  abr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  ago: 8,
  sep: 9,
  set: 9,
  oct: 10,
  nov: 11,
  dic: 12,
};

/** Full month names (and «sept»); any other word only counts as a month by its three letters. */
const MONTH_NAMES = [
  'enero',
  'febrero',
  'marzo',
  'abril',
  'mayo',
  'junio',
  'julio',
  'agosto',
  'septiembre',
  'setiembre',
  'octubre',
  'noviembre',
  'diciembre',
  'sept',
];
const isMonthName = (word: string) => MONTH_NAMES.includes(word);

/** YYYY-MM-DD when the parts form a real calendar day, else null. */
const calendarDay = (year: number, month: number, day: number): string | null => {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1) return null;
  if (date.getUTCDate() !== day || year < 1900 || year > 2200) return null;
  return date.toISOString().slice(0, 10);
};

/** Excel stores days as a count from 1899-12-30; only plausible years (1954–2119) are read. */
const EXCEL_EPOCH = Date.UTC(1899, 11, 30);
const excelDay = (serial: number) =>
  serial >= 20_000 && serial < 80_000
    ? new Date(EXCEL_EPOCH + Math.floor(serial) * 86_400_000).toISOString().slice(0, 10)
    : null;

/**
 * The calendar day a date value names, as YYYY-MM-DD, or null. Reads the shapes imports carry:
 * ISO with or without time (the written day is kept, not shifted by the zone), YYYY/MM/DD,
 * day-first D/M/YYYY, D-M-YYYY and D.M.YYYY, Spanish month names or abbreviations
 * («15 oct 2026», «15 de octubre de 2026») and Excel serial day numbers.
 */
export const parseDay = (value: unknown): string | null => {
  if (typeof value === 'number') return Number.isFinite(value) ? excelDay(value) : null;
  const text = foldText(value).trim();
  if (!text) return null;
  if (/^\d+(\.\d+)?$/.test(text)) return excelDay(Number(text));
  const [, y1, m1, d1] = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?!\d)/.exec(text) ?? [];
  if (y1 && m1 && d1) return calendarDay(+y1, +m1, +d1);
  const [, d2, m2, y2] = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})(?!\d)/.exec(text) ?? [];
  if (y2 && m2 && d2) return calendarDay(+y2, +m2, +d2);
  const [, d3, word, y3] =
    /(\d{1,2})(?:\s+de)?[\s\-/.]+([a-z]{3,10})\.?(?:\s+del?)?[\s\-/.,]+(\d{4})/.exec(text) ?? [];
  const month = word && (word.length === 3 || isMonthName(word)) ? MONTHS[word.slice(0, 3)] : 0;
  if (y3 && month && d3) return calendarDay(+y3, month, +d3);
  return null;
};

/**
 * Date fields a narrative may carry, in order of trust: publication, observation, the generic
 * «Fecha» and «Fecha_Registro» some imports use, and the record's last change as last resort.
 */
export const NARRATIVE_DATE_FIELDS = [
  'Fecha_Inicio',
  'Fecha_Observacion',
  'Fecha',
  'Fecha_Registro',
  '_updated_at',
] as const;

/** The narrative's day and the field it came from, or null when no field holds a usable date. */
export const narrativeDate = (
  record: ModuleRecord,
): { day: string; field: (typeof NARRATIVE_DATE_FIELDS)[number] } | null => {
  for (const field of NARRATIVE_DATE_FIELDS) {
    const day = parseDay(record[field]);
    if (day) return { day, field };
  }
  return null;
};

/** The narrative's day as YYYY-MM-DD, or null when unknown. */
export const narrativeDay = (record: ModuleRecord): string | null =>
  narrativeDate(record)?.day ?? null;

const DAY_MS = 86_400_000;
const addDays = (day: string, n: number) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

export type TrendWindow = 30 | 90 | 'todo';

/**
 * Narratives per day and category, with zero-filled days. The window ends on the latest real
 * narrative date so a quiet week does not empty the chart; at least seven days are shown.
 */
export const narrativeTrend = (rows: readonly ModuleRecord[], window: TrendWindow) => {
  const categorised = rows.map((row) => ({
    date: narrativeDate(row),
    code: narrativeCategory(row),
  }));
  const dated = categorised.flatMap(({ date, code }) =>
    date ? [{ day: date.day, code, real: date.field !== '_updated_at' }] : [],
  );
  const undated = rows.length - dated.length;
  const fromUpdate = categorised.filter(({ date }) => date?.field === '_updated_at').length;
  const datedDays = new Set(dated.map((d) => d.day)).size;
  const byCategory = TREND_SERIES.map(({ code, label }) => ({
    code,
    label,
    value: categorised.filter((c) => c.code === code).length,
  }))
    .filter((c) => c.value > 0)
    .sort((a, b) => b.value - a.value);
  const empty = { days: [], series: [], total: 0, undated, fromUpdate, datedDays, byCategory };
  if (!dated.length) return empty;
  const span = window === 'todo' ? Infinity : window;
  // Real dates set the window. A last-change day only extends it while the latest real date
  // stays inside, so a recent edit cannot push older publications out of a 30- or 90-day view.
  const realDays = dated.filter((d) => d.real).map((d) => d.day);
  const lastReal = realDays.length ? realDays.sort()[realDays.length - 1] : undefined;
  const reach = (day: string) =>
    !lastReal || Date.parse(day) - Date.parse(lastReal) < span * DAY_MS;
  const sorted = dated
    .map((d) => d.day)
    .filter(reach)
    .sort();
  const last = sorted[sorted.length - 1] ?? '';
  const first = sorted[0] ?? last;
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
  return { days, series, total, undated, fromUpdate, datedDays, byCategory };
};
