import { randomBytes } from 'node:crypto';
import { reviewRecordsPort } from '../../compose.ts';
import {
  type MaterializeReport,
  materializeApprovedReviews,
} from '../../contexts/documents/application/index.ts';
import { createSqlReviewStore } from '../../contexts/documents/infrastructure/index.ts';
import { createRecordsService } from '../../contexts/records/application/index.ts';
import { createSqlRecordStore } from '../../contexts/records/infrastructure/sql-record-store.ts';
import type { SqlClient } from '../../platform/database/sql-client.ts';

export type ReviewMaterializeRun = {
  readonly applied: boolean;
  readonly tenants: readonly MaterializeReport[];
  /** A requested `--scope` that does not exist. */
  readonly missing: readonly string[];
};

/**
 * Creates the records of review items approved before approvals did (functional-closure T23),
 * tenant by tenant, through the same records port the inbox uses. Dry run unless `apply`.
 */
export const runReviewMaterialize = async (
  sql: SqlClient,
  options: { apply: boolean; scope?: string; now: () => Date },
): Promise<ReviewMaterializeRun> => {
  const tenants = (
    await sql.query<{ tenant_id: string }>(
      `SELECT tenant_id FROM tenants WHERE ($1::text IS NULL OR tenant_id = $1)
        ORDER BY tenant_id`,
      [options.scope ?? null],
    )
  ).map((row) => row.tenant_id);
  const records = reviewRecordsPort(
    createRecordsService({
      store: createSqlRecordStore(sql),
      clock: { now: options.now },
      // Only ids a caller leaves out are random; review records always bring their own.
      randomHex: (length) =>
        randomBytes(Math.ceil(length / 2))
          .toString('hex')
          .slice(0, length)
          .toUpperCase(),
    }),
  );
  const reviews = createSqlReviewStore(sql);
  const reports = [];
  for (const tenant of tenants)
    reports.push(await materializeApprovedReviews({ reviews, records }, tenant, options));
  return {
    applied: options.apply,
    tenants: reports,
    missing: options.scope && tenants.length === 0 ? [options.scope] : [],
  };
};
