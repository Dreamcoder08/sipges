/**
 * Parameter types a statement already declares with casts, so the driver can send the query
 * in one round trip. postgres.js sends a parameter whose type it does not know as "unknown"
 * and waits for the server to describe the statement before binding values: a second round
 * trip, about 130 ms from Lima to the database. A declared type removes that wait.
 *
 * Conservative on purpose: a parameter is declared only when every use of it in the SQL has
 * the same scalar cast below and its JavaScript value already has that type. Anything else
 * (bare uses, arrays, json, mismatched values) stays unknown, which is the previous behaviour.
 */

/** Cast spellings mapped to the PostgreSQL type oid and the values that type accepts as-is. */
const SCALARS: Readonly<Record<string, { oid: number; accepts: (value: unknown) => boolean }>> = {
  text: { oid: 25, accepts: (v) => typeof v === 'string' },
  integer: { oid: 23, accepts: (v) => Number.isInteger(v) },
  int: { oid: 23, accepts: (v) => Number.isInteger(v) },
  int4: { oid: 23, accepts: (v) => Number.isInteger(v) },
  bigint: { oid: 20, accepts: (v) => Number.isInteger(v) || typeof v === 'bigint' },
  int8: { oid: 20, accepts: (v) => Number.isInteger(v) || typeof v === 'bigint' },
  boolean: { oid: 16, accepts: (v) => typeof v === 'boolean' },
  bool: { oid: 16, accepts: (v) => typeof v === 'boolean' },
  timestamptz: { oid: 1184, accepts: (v) => v instanceof Date && !Number.isNaN(v.getTime()) },
};

/** `$n` followed by an optional cast; the lookahead keeps `$1` from matching `$10`. */
const PLACEHOLDER = /\$(\d+)(?!\d)(?:::([a-z_][a-z0-9_]*)(\s*\[\])?)?/gi;

/** Casts per parameter position, or null when a use is bare, an array or not a known scalar. */
const castsOf = (text: string): ReadonlyMap<number, string | null> => {
  const casts = new Map<number, string | null>();
  for (const [, position, cast, array] of text.matchAll(PLACEHOLDER)) {
    const index = Number(position) - 1;
    const name = !array && cast ? cast.toLowerCase() : null;
    const known = name && name in SCALARS ? name : null;
    const previous = casts.get(index);
    casts.set(index, previous === undefined || previous === known ? known : null);
  }
  return casts;
};

/** Statements are static text; the cache stays small and skips re-parsing hot queries. */
const CACHE_LIMIT = 500;
const cache = new Map<string, ReadonlyMap<number, string | null>>();
const cachedCastsOf = (text: string) => {
  let casts = cache.get(text);
  if (!casts) {
    casts = castsOf(text);
    if (cache.size >= CACHE_LIMIT) cache.clear();
    cache.set(text, casts);
  }
  return casts;
};

/** The oid to declare for each parameter, 0 for "let the server infer it". */
export const declaredParameterTypes = (text: string, params: readonly unknown[]): number[] => {
  const casts = cachedCastsOf(text);
  return params.map((value, index) => {
    const cast = casts.get(index);
    const scalar = cast ? SCALARS[cast] : undefined;
    return scalar && (value === null || scalar.accepts(value)) ? scalar.oid : 0;
  });
};
