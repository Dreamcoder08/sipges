import {
  REVIEW_SOURCE,
  projectOf,
  reviewRecordFields,
  reviewRecordId,
  reviewTarget,
} from '../domain/index.ts';
import type { ReviewRecordWriter, ReviewStore } from './ports.ts';

/** Counts only, never record values (docs/operations/review-materialize.md). */
export type MaterializeReport = {
  readonly tenant: string;
  readonly approved: number;
  readonly modules: readonly {
    readonly module: string;
    readonly nuevos: number;
    readonly ya_existentes: number;
  }[];
  readonly problems: readonly string[];
};

/**
 * Backfill for items approved before approvals created records (functional-closure T23).
 * Inserts only the missing records under their deterministic ids, so it can be re-run or
 * resumed after a failure without duplicates. Dry run unless `apply`. Each batch of one module
 * is one records transaction.
 */
export const materializeApprovedReviews = async (
  deps: { reviews: ReviewStore; records: ReviewRecordWriter },
  tenantId: string,
  options: { apply: boolean; pageSize?: number },
): Promise<MaterializeReport> => {
  const pageSize = options.pageSize ?? 500;
  const byModule = new Map<string, { id: string; fields: Record<string, string> }[]>();
  let approved = 0;
  for (let afterId = ''; ;) {
    const page = await deps.reviews.approved(tenantId, { afterId, limit: pageSize });
    for (const item of page) {
      const { module } = reviewTarget(item.theme);
      const rows = byModule.get(module) ?? [];
      rows.push({
        id: reviewRecordId(item.id),
        fields: reviewRecordFields(item, projectOf(tenantId)),
      });
      byModule.set(module, rows);
    }
    approved += page.length;
    const last = page.at(-1);
    if (!last || page.length < pageSize) break;
    afterId = last.id;
  }
  const modules = [];
  const problems: string[] = [];
  for (const [module, rows] of [...byModule].sort(([a], [b]) => a.localeCompare(b))) {
    let nuevos = 0;
    let existentes = 0;
    for (let start = 0; start < rows.length; start += pageSize) {
      const result = await deps.records.createMissing(
        tenantId,
        module,
        rows.slice(start, start + pageSize),
        { dryRun: !options.apply, source: REVIEW_SOURCE },
      );
      nuevos += result.created;
      existentes += result.existing;
      problems.push(...result.problems.map((problem) => `${module}: ${problem}`));
    }
    modules.push({ module, nuevos, ya_existentes: existentes });
  }
  return { tenant: tenantId, approved, modules, problems };
};
