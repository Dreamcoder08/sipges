import type { DemoRecord, academicDemo } from './dataset.ts';

type Dataset = ReturnType<typeof academicDemo>;
type Existing = Readonly<Record<string, readonly Readonly<Record<string, unknown>>[]>>;

/** Plans additions only. Re-running never replaces an existing record or a user's edits. */
export const planDemoImport = (dataset: Dataset, existing: Existing) => {
  const create: DemoRecord[] = [];
  const skip: string[] = [];
  for (const row of dataset.records) {
    const candidates = existing[row.module] ?? [];
    const matches = candidates.filter((candidate) => candidate.Demo_ID === row.key);
    if (matches.length > 1) throw new Error(`Duplicate demo marker: ${row.key}`);
    if (matches.length === 1) {
      if (matches[0]?.Demo_Dataset !== dataset.version || matches[0]?.Dato_Sintetico !== true) {
        throw new Error(`Demo marker collision: ${row.key}`);
      }
      skip.push(row.key);
      continue;
    }
    if (candidates.some((candidate) => candidate._id === row.key)) {
      throw new Error(`Reserved record id collision: ${row.key}`);
    }
    create.push(row);
  }
  return { create, skip };
};
