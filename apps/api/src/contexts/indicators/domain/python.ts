/**
 * Python semantics the indicator rules of app.py depend on. Pure helpers, no I/O.
 */

/** Python truthiness for JSON values. */
export const truthy = (value: unknown): boolean => {
  if (value === null || value === undefined || value === false || value === 0 || value === '')
    return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
};

/** Python `str(value)` for JSON values (`None` for null/undefined). */
export const pyStr = (value: unknown): string => {
  if (value === null || value === undefined) return 'None';
  if (value === true) return 'True';
  if (value === false) return 'False';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return JSON.stringify(value);
};

/** Python `str(value or "")`. */
export const text = (value: unknown): string => (truthy(value) ? pyStr(value) : '');

/** Python `a or b or ...`: the first truthy value, else the last one. */
export const firstTruthy = (...values: unknown[]): unknown =>
  values.find(truthy) ?? values[values.length - 1];

/**
 * Python `round(x, digits)`: correctly rounded on the exact binary value, ties to even.
 * `toFixed(100)` yields the exact decimal expansion for the magnitudes used here.
 */
export const pyRound = (x: number, digits: number): number => {
  if (!Number.isFinite(x) || x === 0) return x === 0 ? 0 : x;
  const [whole = '0', fraction = ''] = Math.abs(x).toFixed(100).split('.');
  const kept = fraction.slice(0, digits);
  const rest = fraction.slice(digits).replace(/0+$/, '');
  let scaled = BigInt(whole + kept);
  const tie = rest === '5';
  if ((rest > '5' && !tie) || (tie && scaled % 2n === 1n)) scaled += 1n;
  const result = Number(scaled) / 10 ** digits;
  return x < 0 ? -result : result;
};

/** Python `str(float)`: integral floats keep one decimal (`25.0`). */
export const pyFloat = (x: number): string => (Number.isInteger(x) ? x.toFixed(1) : String(x));
