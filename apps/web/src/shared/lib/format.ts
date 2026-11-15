import { isValidCalendarDate, limaToday } from '@sipges/kernel';

/**
 * How SIPGES writes dates and numbers for people (odd/tasks/functional-10.md T1 and T2). Every
 * screen goes through these helpers, so one page never mixes `2026-11-14`, «15 nov.» and
 * `2026-11-15T03:33:35Z`, or `10.75` next to «0,02». Machine values (`<time datetime>`, CSV
 * exports, form inputs) keep their stored form.
 */

const LIMA = 'America/Lima';

// Stored instants: `YYYY-MM-DDTHH:MM[:SS[.fff]]` with `Z`, an offset, or nothing (UTC, as the API
// writes them).
const INSTANT = /^(\d{4}-\d{2}-\d{2})[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;

const instantOf = (value: string | Date): Date | null => {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const text = value.trim();
  const match = INSTANT.exec(text);
  if (!match || !isValidCalendarDate(match[1])) return null;
  const at = new Date(`${text.replace(' ', 'T')}${match[2] ? '' : 'Z'}`);
  return Number.isNaN(at.getTime()) ? null : at;
};

/**
 * The calendar day (`YYYY-MM-DD`) a person in Peru reads for a stored value: a stored day as it
 * is, an instant as its day in Lima (03:33 UTC on the 15th is the 14th). Null for anything else.
 */
export const limaDay = (value: unknown): string | null => {
  if (value instanceof Date) {
    const at = instantOf(value);
    return at ? limaToday(at) : null;
  }
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (isValidCalendarDate(text)) return text;
  const at = instantOf(text);
  return at ? limaToday(at) : null;
};

// Days are formatted at noon UTC of the calendar day they name, so no timezone moves them.
const noon = (day: string) => new Date(`${day}T12:00:00Z`);
const DAY = new Intl.DateTimeFormat('es-PE', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});
const SHORT_DAY = new Intl.DateTimeFormat('es-PE', {
  day: 'numeric',
  month: 'short',
  timeZone: 'UTC',
});
const LONG_DAY = new Intl.DateTimeFormat('es-PE', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
});
const TIME = new Intl.DateTimeFormat('es-PE', {
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
  timeZone: LIMA,
});

type DateInput = string | Date | null | undefined;
const text = (value: DateInput) => (value instanceof Date ? '' : (value ?? '').trim());
const withDay = (value: DateInput, format: Intl.DateTimeFormat) => {
  const day = limaDay(value);
  return day ? format.format(noon(day)) : text(value);
};

/** «14 nov. 2026». Text that is not a date (a narrative deadline) is returned as it is. */
export const formatDay = (value: DateInput) => withDay(value, DAY);

/** «14 nov.», for chart axes where the year is in the caption. */
export const formatShortDay = (value: DateInput) => withDay(value, SHORT_DAY);

/** «sábado, 14 de noviembre de 2026», for the date at the head of a page. */
export const formatLongDay = (value: Date = new Date()) => withDay(value, LONG_DAY);

/** «14 nov. 2026, 22:33» in Lima time; a day without a time keeps the day form. */
export const formatDateTime = (value: DateInput) => {
  const stored = text(value);
  const at = value instanceof Date ? instantOf(value) : stored ? instantOf(stored) : null;
  if (!at) return formatDay(value);
  return `${DAY.format(noon(limaToday(at)))}, ${TIME.format(at)}`;
};

const NUMBER = new Map<number, Intl.NumberFormat>();
/**
 * Spanish digits: decimal comma, a point between thousands from five digits up (RAE), and always
 * `decimals` decimals. A value that rounds to zero is never written «-0».
 */
export const formatNumber = (value: number, decimals = 0) => {
  let format = NUMBER.get(decimals);
  if (!format) {
    format = new Intl.NumberFormat('es', {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
      signDisplay: 'negative',
    });
    NUMBER.set(decimals, format);
  }
  return format.format(value);
};

/**
 * Decimals for each kind of value, the same on every screen: an IRSA value, a dimension score or
 * the points of a factor (0–100) has one; a share (availability, weight) has one; a count none.
 */
export const DECIMALS = { index: 1, share: 1, count: 0 } as const;

/** An IRSA value, a dimension or indicator score, or the points a factor adds: «10,8». */
export const formatIndex = (value: number) => formatNumber(value, DECIMALS.index);

/** A value already in percent (0–100): «66,7 %», with a no-break space before the sign. */
export const formatPercent = (value: number, decimals: number = DECIMALS.share) =>
  `${formatNumber(value, decimals)}\u00a0%`;

/**
 * Fractions of one (IRSA weights) as percentages that add up on screen: largest-remainder
 * rounding, so six weights of 0,1666667 and 0,1666665 read 16,7 % ×4 and 16,6 % ×2 (total
 * 100,0 %) instead of a rounding artefact. Ties go to the earlier value.
 */
export const formatShares = (values: readonly number[], decimals: number = DECIMALS.share) => {
  const unit = 100 * 10 ** decimals;
  const scaled = values.map((value) => (Number.isFinite(value) ? value * unit : 0));
  const floors = scaled.map(Math.floor);
  const target = Math.round(scaled.reduce((sum, value) => sum + value, 0));
  let missing = target - floors.reduce((sum, value) => sum + value, 0);
  const order = scaled
    .map((value, index) => ({ index, rest: value - Math.floor(value) }))
    .sort((a, b) => b.rest - a.rest || a.index - b.index);
  for (const { index } of order) {
    if (missing <= 0) break;
    floors[index] = (floors[index] ?? 0) + 1;
    missing -= 1;
  }
  return floors.map((units) => formatPercent(units / 10 ** decimals, decimals));
};
