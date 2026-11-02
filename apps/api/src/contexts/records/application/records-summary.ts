import {
  type RecordSummary,
  SUMMARY_TYPES,
  type SummarySlug,
  summarizeRecord,
} from '../domain/summary.ts';
import type { RecordSummaryReader } from './ports.ts';
import { boundLimit } from './records-service.ts';

export type RecordsSummaryPage = {
  readonly counts: Readonly<Record<SummarySlug, number>>;
  readonly rows: readonly (RecordSummary & { readonly updatedAt: Date })[];
};

/** Registros «Todos» in one query: the shared columns of every hub type plus their totals. */
export const createRecordsSummary =
  (deps: { reader: RecordSummaryReader }) =>
  async (
    tenantId: string,
    query: { limit: number; offset: number; q: string | null },
  ): Promise<RecordsSummaryPage> => {
    const { rows, counts } = await deps.reader.summary(
      tenantId,
      SUMMARY_TYPES.map((type) => type.module),
      { limit: boundLimit(query.limit), offset: query.offset, q: query.q || null },
    );
    const typeOf = new Map(SUMMARY_TYPES.map((type) => [type.module as string, type]));
    return {
      counts: Object.fromEntries(
        SUMMARY_TYPES.map((type) => [type.slug, counts.get(type.module) ?? 0]),
      ) as Record<SummarySlug, number>,
      rows: rows.flatMap((row) => {
        const type = typeOf.get(row.module);
        return type
          ? [{ ...summarizeRecord(type, row.id, row.payload), updatedAt: row.updatedAt }]
          : [];
      }),
    };
  };

export type RecordsSummaryQuery = ReturnType<typeof createRecordsSummary>;
