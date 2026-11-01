import { randomUUID } from 'node:crypto';
import type { SqlClient } from '../../../platform/database/sql-client.ts';
import { withTenant } from '../../../platform/database/tenant-transaction.ts';
import { currentRequestContext, runWithRequestContext } from '../../../platform/request-context.ts';
import type { NameDirectory } from '../application/index.ts';
import { NAME_SOURCES } from '../domain/allowlist.ts';

type Row = { module: string; field: string; value: string };

/** Bound on the names scanned per project; a project holds far fewer. */
const MAX_NAMES = 20_000;

/**
 * Reads the values of every person and organisation field of the project (the fields the
 * allowlist treats as names) so free text can be scrubbed of them. It reads with full clearance
 * on purpose: a restricted record's name must be replaced too, and it only ever feeds the
 * scrubber, never an output.
 */
export const createSqlNameDirectory = (sql: SqlClient): NameDirectory => ({
  load: (tenantId) => {
    const context = currentRequestContext();
    return runWithRequestContext(
      {
        requestId: context?.requestId ?? randomUUID(),
        ...(context?.trace ? { trace: context.trace } : {}),
        actor: context?.actor ?? null,
        clearance: 'full',
      },
      () =>
        withTenant(sql, tenantId, async (tx) => {
          const rows = await tx.query<Row>(
            `SELECT DISTINCT r.module, s.field, btrim(r.payload ->> s.field) AS value
               FROM module_records r
               JOIN unnest($1::text[], $2::text[]) AS s(module, field) ON s.module = r.module
              WHERE r.tenant_id = $3 AND btrim(coalesce(r.payload ->> s.field, '')) <> ''
              LIMIT $4`,
            [
              NAME_SOURCES.map((s) => s.module),
              NAME_SOURCES.map((s) => s.field),
              tenantId,
              MAX_NAMES,
            ],
          );
          return rows.flatMap((row) => {
            const source = NAME_SOURCES.find(
              (s) => s.module === row.module && s.field === row.field,
            );
            return source ? [{ kind: source.entity, name: row.value }] : [];
          });
        }),
    );
  },
});
