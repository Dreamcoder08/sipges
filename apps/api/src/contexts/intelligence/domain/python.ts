/** Python behaviors the ported engines depend on for identical results. */

/** Python `round`, shared with other contexts through the kernel. */
export { roundHalfEven as pyRound } from '@mascli/kernel';

/** Python string length and slicing count code points. */
export const codePoints = (text: string) => Array.from(text);

export const sliceCodePoints = (text: string, count: number) =>
  codePoints(text).slice(0, count).join('');

/** `str(value)` of a JSON value. */
export const pyStr = (value: unknown): string => {
  if (value === undefined) return '';
  if (value === null) return 'None';
  if (value === true) return 'True';
  if (value === false) return 'False';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return JSON.stringify(value);
};

/** Python truthiness of a JSON value. */
export const pyTruthy = (value: unknown): boolean => {
  if (value === undefined || value === null || value === false || value === 0 || value === '')
    return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
};

const escapeJsonString = (text: string) =>
  // json.dumps escapes every C0 control character.
  // eslint-disable-next-line no-control-regex
  `"${text.replace(/[\\"\u0000-\u001f]/g, (ch) => {
    switch (ch) {
      case '"':
        return '\\"';
      case '\\':
        return '\\\\';
      case '\n':
        return '\\n';
      case '\r':
        return '\\r';
      case '\t':
        return '\\t';
      case '\b':
        return '\\b';
      case '\f':
        return '\\f';
      default:
        return `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`;
    }
  })}"`;

/** `json.dumps(value, ensure_ascii=False)`: `, ` and `: ` separators, keys in insertion order. */
export const pyJsonDumps = (value: unknown): string => {
  if (value === null || value === undefined) return 'null';
  if (value === true) return 'true';
  if (value === false) return 'false';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NaN';
  if (typeof value === 'string') return escapeJsonString(value);
  if (Array.isArray(value)) return `[${value.map(pyJsonDumps).join(', ')}]`;
  if (typeof value === 'object')
    return `{${Object.entries(value)
      .map(([k, v]) => `${escapeJsonString(k)}: ${pyJsonDumps(v)}`)
      .join(', ')}}`;
  return 'null';
};

/** Lower case, decomposed, nonspacing marks removed (app.py `_rc24_norm` uses NFKD). */
export const foldMarks = (text: string, form: 'NFD' | 'NFKD' = 'NFKD') =>
  text
    .toLowerCase()
    .normalize(form)
    .replace(/\p{Mn}/gu, '');

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** `re.search(r'(?<!\w)' + re.escape(w) + r'(?!\w)', text)` with Unicode word characters. */
export const hasWholeWord = (text: string, word: string) =>
  new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegExp(word)}(?![\\p{L}\\p{N}_])`, 'u').test(text);
