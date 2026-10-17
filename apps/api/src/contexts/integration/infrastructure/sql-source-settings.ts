import type { AuthorizedSourceState } from '@mascli/contracts';
import type { SqlClient } from '../../../platform/database/sql-client.ts';
import { withTenant } from '../../../platform/database/tenant-transaction.ts';
import { emptySourceState, type SourceSettingsStore } from '../application/authorized-sources.ts';
type Row = AuthorizedSourceState;
const iso = (value: string | null) => (value ? new Date(value).toISOString() : null);
const mapped = (row: Row | undefined): AuthorizedSourceState =>
  row
    ? { ...row, updated_at: iso(row.updated_at), last_poll_at: iso(row.last_poll_at) }
    : emptySourceState();
const columns =
  'enabled,query,territory,authorization_note,revision,updated_by,updated_at,last_poll_at,last_poll_error,last_imported,last_duplicates';
export const createSqlSourceSettings = (sql: SqlClient): SourceSettingsStore => ({
  get: (tenantId) =>
    withTenant(sql, tenantId, async (tx) =>
      mapped(
        (
          await tx.query<Row>(
            `SELECT ${columns} FROM source_import_settings WHERE tenant_id=$1 AND source_id='defensoria'`,
            [tenantId],
          )
        )[0],
      ),
    ),
  save: (tenantId, input, username, at) =>
    withTenant(sql, tenantId, async (tx) => {
      const [row] = await tx.query<Row>(
        `INSERT INTO source_import_settings (tenant_id,source_id,enabled,query,territory,authorization_note,updated_by,updated_at)
  VALUES ($1,'defensoria',$2,$3,$4,$5,$6,$7) ON CONFLICT (tenant_id,source_id) DO UPDATE SET
  enabled=EXCLUDED.enabled,query=EXCLUDED.query,territory=EXCLUDED.territory,authorization_note=EXCLUDED.authorization_note,
  revision=source_import_settings.revision+1,updated_by=EXCLUDED.updated_by,updated_at=EXCLUDED.updated_at RETURNING ${columns}`,
        [
          tenantId,
          input.enabled,
          input.query,
          input.territory,
          input.authorization_note,
          username,
          at,
        ],
      );
      return mapped(row);
    }),
  claimPoll: (tenantId, revision, at) =>
    withTenant(
      sql,
      tenantId,
      async (tx) =>
        (
          await tx.query(
            `UPDATE source_import_settings SET last_poll_at=$3,last_poll_error='' WHERE tenant_id=$1 AND source_id='defensoria' AND enabled AND revision=$2 AND (last_poll_at IS NULL OR last_poll_at <= $3::timestamptz - interval '15 minutes') RETURNING tenant_id`,
            [tenantId, revision, at],
          )
        ).length > 0,
    ),
  finishPoll: (tenantId, at, outcome) =>
    withTenant(sql, tenantId, async (tx) => {
      await tx.query(
        `UPDATE source_import_settings SET last_poll_error=$3,last_imported=$4,last_duplicates=$5 WHERE tenant_id=$1 AND source_id='defensoria' AND last_poll_at=$2`,
        [tenantId, at, outcome.error, outcome.imported, outcome.duplicates],
      );
    }),
  // Trusted owner enumeration, matching the automation cursor scheduler; never request scoped.
  activeTenants: async () =>
    (
      await sql.query<{ tenant_id: string }>(
        'SELECT tenant_id FROM source_import_settings WHERE enabled ORDER BY last_poll_at ASC NULLS FIRST,tenant_id LIMIT 200',
      )
    ).map((row) => row.tenant_id),
});
