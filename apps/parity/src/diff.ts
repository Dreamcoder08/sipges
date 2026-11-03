/**
 * Compares one response of the TypeScript API with the same response of the Go API: status,
 * media type and body. JSON bodies compare as values (object key order is not part of JSON);
 * any other body compares as exact text. Only the paths a case declares are normalized.
 */

export type Body =
  | { readonly kind: 'json'; readonly value: unknown }
  | { readonly kind: 'text'; readonly value: string };

export type Observed = {
  readonly status: number;
  readonly contentType: string | undefined;
  readonly body: Body;
};

export type Mismatch =
  | { readonly field: 'status'; readonly ts: number; readonly go: number }
  | {
      readonly field: 'content-type';
      readonly ts: string | undefined;
      readonly go: string | undefined;
    }
  | { readonly field: 'body'; readonly path: string; readonly ts: unknown; readonly go: unknown };

/** The value a normalized field takes on both sides. */
export const NORMALIZED = '<normalized>';

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** `application/json; charset=utf-8` → `application/json`. */
const mediaType = (contentType: string | undefined) =>
  contentType?.split(';')[0]?.trim().toLowerCase() || undefined;

/**
 * Returns a copy of `value` with every declared path replaced by NORMALIZED where it exists.
 * A path is dot-separated keys; `*` stands for every element of an array (`items.*.id`).
 */
export const normalize = (value: unknown, paths: readonly string[]): unknown =>
  paths.reduce((current, path) => replaceAt(current, path.split('.')), value);

const replaceAt = (value: unknown, [head, ...rest]: readonly string[]): unknown => {
  if (head === undefined) return NORMALIZED;
  if (head === '*')
    return Array.isArray(value) ? value.map((item) => replaceAt(item, rest)) : value;
  if (!isObject(value) || !Object.hasOwn(value, head)) return value;
  return { ...value, [head]: replaceAt(value[head], rest) };
};

const diffValues = (ts: unknown, go: unknown, path: string, out: Mismatch[]) => {
  if (Array.isArray(ts) && Array.isArray(go)) {
    for (let i = 0; i < Math.max(ts.length, go.length); i++) {
      diffValues(ts[i], go[i], `${path}[${i}]`, out);
    }
    return;
  }
  if (isObject(ts) && isObject(go)) {
    const keys = [...new Set([...Object.keys(ts), ...Object.keys(go)])].sort();
    for (const key of keys) {
      diffValues(
        Object.hasOwn(ts, key) ? ts[key] : undefined,
        Object.hasOwn(go, key) ? go[key] : undefined,
        `${path}.${key}`,
        out,
      );
    }
    return;
  }
  // Primitives (and a missing key vs null, which JSON distinguishes) compare strictly.
  if (!Object.is(ts, go)) out.push({ field: 'body', path, ts, go });
};

/** Every difference between the two responses, after normalizing the declared JSON paths. */
export const compare = (
  ts: Observed,
  go: Observed,
  normalized: readonly string[] = [],
): Mismatch[] => {
  const out: Mismatch[] = [];
  if (ts.status !== go.status) out.push({ field: 'status', ts: ts.status, go: go.status });
  const [tsType, goType] = [mediaType(ts.contentType), mediaType(go.contentType)];
  if (tsType !== goType) out.push({ field: 'content-type', ts: tsType, go: goType });
  if (ts.body.kind === 'json' && go.body.kind === 'json') {
    diffValues(
      normalize(ts.body.value, normalized),
      normalize(go.body.value, normalized),
      '$',
      out,
    );
  } else if (ts.body.kind !== go.body.kind || ts.body.value !== go.body.value) {
    out.push({ field: 'body', path: '$', ts: ts.body.value, go: go.body.value });
  }
  return out;
};
