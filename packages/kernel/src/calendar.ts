/** A real date in the proleptic Gregorian calendar, without Date rollover. */
export const isValidCalendarDate = (value: unknown): value is string => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= (days[month - 1] ?? 0);
};

export const normalizeSpanishStatus = (value: unknown): string =>
  typeof value === 'string'
    ? value
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, ' ')
    : '';

const COMPLETED = new Set([
  'cumplido',
  'cumplida',
  'completado',
  'completada',
  'cerrado',
  'cerrada',
  'atendido',
  'atendida',
  'resuelto',
  'resuelta',
  'finalizado',
  'finalizada',
]);
export const isCompletedStatus = (value: unknown): boolean =>
  COMPLETED.has(normalizeSpanishStatus(value));
export const isTerminalStatus = (value: unknown): boolean =>
  isCompletedStatus(value) || ['cancelado', 'cancelada'].includes(normalizeSpanishStatus(value));

/** Project reporting uses the calendar day in Peru, independent of the host timezone. */
export const limaToday = (now: Date = new Date()): string => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Lima',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
};

/** An explicitly cleared or malformed deadline blocks fallback to imported aliases. */
export const recordDueDate = (payload: Readonly<Record<string, unknown>>): string | null => {
  for (const key of ['Fecha_Vencimiento', 'Fecha_Limite', 'Plazo']) {
    if (!Object.hasOwn(payload, key)) continue;
    const value = payload[key];
    return isValidCalendarDate(value) ? value : null;
  }
  return null;
};
