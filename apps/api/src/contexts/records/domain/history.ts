import type { Payload } from './modules.ts';

export type VersionOperation = 'BASELINE' | 'CREATE' | 'UPDATE' | 'DELETE';

export type FieldChange = {
  readonly field: string;
  readonly before: unknown;
  readonly after: unknown;
};

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Field-level difference between two payload versions, sorted by field name (jsonb does not
 * keep key order). `undefined` means the field was absent.
 */
export const diffPayloads = (before: Payload | null, after: Payload | null): FieldChange[] => {
  const previous = before ?? {};
  const next = after ?? {};
  const fields = [...new Set([...Object.keys(previous), ...Object.keys(next)])].sort();
  return fields
    .filter((field) => !same(previous[field], next[field]))
    .map((field) => ({ field, before: previous[field], after: next[field] }));
};
