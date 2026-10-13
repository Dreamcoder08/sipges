/**
 * Minimal Python value semantics the app.py engines rely on, so JSON payloads produce the
 * same results: `str(value)`, truthiness, and `Counter.most_common`.
 */

/** Python `str()` of a JSON value. */
export const pyStr = (value: unknown): string => {
  if (value === undefined) return '';
  if (value === null) return 'None';
  if (value === true) return 'True';
  if (value === false) return 'False';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  return JSON.stringify(value);
};

/** Python truthiness of a JSON value (`x or default`). */
export const pyTruthy = (value: unknown): boolean => {
  if (value === undefined || value === null || value === false || value === 0 || value === '')
    return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
};

/** `str(value).strip()` with Python's whitespace set approximated by JavaScript `trim`. */
export const pyStrip = (value: unknown) => pyStr(value).trim();

/** `dict.get(key, default)`: the stored value even when null, the default only when absent. */
export const pyGet = (
  record: Readonly<Record<string, unknown>>,
  key: string,
  fallback: unknown = '',
) => (Object.hasOwn(record, key) ? record[key] : fallback);

/** `Counter(values).most_common(limit)`: count desc, ties in first-seen order. */
export const mostCommon = (values: readonly string[], limit?: number): [string, number][] => {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  const sorted = [...counts].sort((a, b) => b[1] - a[1]);
  return limit === undefined ? sorted : sorted.slice(0, limit);
};
