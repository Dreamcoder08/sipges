/** Records as the egress guard releases them: allowed fields only, names replaced. Pure. */
import { type FieldPolicy, LIST_SEPARATOR, TITLE_FIELDS, policyFor } from './allowlist.ts';
import type { Pseudonymiser } from './pseudonyms.ts';

/** A record as the owning context holds it, before the guard looks at it. */
export type RawRecord = {
  /** Module slug (`actores`, `eventos`...). */
  readonly module: string;
  readonly id: string;
  /** The record's display title: the value of its module's title field, or the id. */
  readonly title?: string;
  readonly date?: string | null;
  /** Classification marking (ADR 0012). Anything but a known open marking is withheld. */
  readonly marking: string | null;
  readonly fields: Readonly<Record<string, unknown>>;
};

export type SanitisedRecord = {
  readonly module: string;
  readonly id: string;
  readonly title: string | null;
  readonly date: string | null;
  readonly marking: string | null;
  /** Restricted (or unclassified) records are withheld whole: no title, no fields. */
  readonly withheld: boolean;
  readonly fields: Readonly<Record<string, string | number>>;
};

/** What the access log keeps of a release: ids and counts, never values. */
export type EgressReport = {
  readonly records: readonly string[];
  readonly sent: number;
  readonly dropped: number;
  /** Records kept back whole because they are restricted; ids only. */
  readonly withheld: readonly string[];
  readonly droppedFields: readonly string[];
};

/** The only markings that may leave; `restringido` and anything unknown never do. */
const OPEN_MARKINGS: readonly string[] = ['publico', 'interno'];

const scalar = (value: unknown): string | number | null => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return String(value);
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
};

/** One field value under its policy; null when nothing is left to send. */
const treat = (
  pseudonymiser: Pseudonymiser,
  policy: FieldPolicy,
  value: string | number,
): string | number | null => {
  const entity = policy.entity ?? 'Persona';
  const pseudonymOf = (raw: string) =>
    pseudonymiser.pseudonym(pseudonymiser.kindOf(raw) ?? entity, raw);
  switch (policy.kind) {
    case 'clear':
    case 'text':
      return typeof value === 'number' ? value : pseudonymiser.scrub(value) || null;
    case 'name':
      return pseudonymOf(String(value));
    case 'names': {
      const items = String(value)
        .split(LIST_SEPARATOR)
        .map((item) => item.trim())
        .filter(Boolean);
      return items.length ? items.map(pseudonymOf).join(', ') : null;
    }
  }
};

export const sanitiseRecords = (
  pseudonymiser: Pseudonymiser,
  records: readonly RawRecord[],
): { records: SanitisedRecord[]; report: EgressReport } => {
  let sent = 0;
  let dropped = 0;
  const droppedFields = new Set<string>();
  const withheld: string[] = [];
  const sanitised = records.map((record): SanitisedRecord => {
    if (!record.marking || !OPEN_MARKINGS.includes(record.marking)) {
      withheld.push(`${record.module}/${record.id}`);
      dropped += Object.values(record.fields).filter(
        (v) => v !== null && v !== undefined && v !== '',
      ).length;
      return {
        module: record.module,
        id: pseudonymiser.scrub(record.id),
        title: null,
        date: null,
        marking: record.marking === 'restringido' ? 'restringido' : null,
        withheld: true,
        fields: {},
      };
    }
    const fields: Record<string, string | number> = {};
    for (const [field, raw] of Object.entries(record.fields)) {
      if (raw === null || raw === undefined || raw === '') continue;
      const policy = policyFor(record.module, field);
      const value = policy ? scalar(raw) : null;
      if (!policy || value === null) {
        dropped += 1;
        droppedFields.add(field);
        continue;
      }
      const treated = treat(pseudonymiser, policy, value);
      if (treated === null) continue;
      fields[field] = treated;
      sent += 1;
    }
    const titleField = TITLE_FIELDS[record.module];
    const titlePolicy = titleField ? policyFor(record.module, titleField) : null;
    const title = record.title ? scalar(record.title) : null;
    const date = record.date ? scalar(record.date) : null;
    return {
      module: record.module,
      id: pseudonymiser.scrub(record.id),
      title:
        titlePolicy && typeof title === 'string'
          ? (treat(pseudonymiser, titlePolicy, title) as string)
          : null,
      date: typeof date === 'string' ? pseudonymiser.scrub(date) : null,
      marking: record.marking,
      withheld: false,
      fields,
    };
  });
  return {
    records: sanitised,
    report: {
      records: records.map((r) => `${r.module}/${r.id}`),
      sent,
      dropped,
      withheld,
      droppedFields: [...droppedFields].sort(),
    },
  };
};
