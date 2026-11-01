/** Lower-case text without accents, as the legacy screens compared labels (app.js normText). */
export const foldText = (value: unknown) =>
  String(value ?? '')
    .normalize('NFD')
    .replace(/\p{Mn}/gu, '')
    .toLowerCase();

export const DIMENSIONS = ['G', 'A', 'D', 'N', 'E', 'I'] as const;
export type DimensionCode = (typeof DIMENSIONS)[number];

export const DIMENSION_NAMES: Readonly<Record<DimensionCode, string>> = {
  G: 'Gobernanza',
  A: 'Actores',
  D: 'Demandas',
  N: 'Narrativas',
  E: 'Ambiental-territorial',
  I: 'Institucional',
};

export const isDimension = (value: string): value is DimensionCode =>
  (DIMENSIONS as readonly string[]).includes(value);

export const LEVELS = ['Verde', 'Amarillo', 'Naranja', 'Rojo'] as const;
export type Level = (typeof LEVELS)[number];

/** Severity band of a free-text level (app.js severityLevel). */
export const severityLevel = (value: unknown): Level => {
  const text = foldText(value);
  if (text.includes('critic') || text.includes('rojo')) return 'Rojo';
  if (text.includes('alta') || text.includes('naranja')) return 'Naranja';
  if (text.includes('media') || text.includes('amarillo')) return 'Amarillo';
  return 'Verde';
};

/** First letter as a SIPGES dimension, if it is one (app.js dimensionCode). */
export const dimensionOf = (value: unknown): DimensionCode | null => {
  const code = String(value ?? '')
    .trim()
    .charAt(0)
    .toUpperCase();
  return isDimension(code) ? code : null;
};

export const formatDateTime = (date: Date) =>
  new Intl.DateTimeFormat('es-PE', { dateStyle: 'medium', timeStyle: 'short' }).format(date);

const MONTH = new Intl.DateTimeFormat('es-PE', { month: 'long', year: 'numeric', timeZone: 'UTC' });
/** "2026-10" → "Octubre de 2026". */
export const monthLabel = (month: string) => {
  const label = MONTH.format(new Date(`${month}-01T12:00:00Z`));
  return label.charAt(0).toUpperCase() + label.slice(1);
};
