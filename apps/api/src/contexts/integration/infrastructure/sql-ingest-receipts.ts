import type { SqlClient } from '../../../platform/database/sql-client.ts';
import { withTenant } from '../../../platform/database/tenant-transaction.ts';
import type { IngestReceipts, IngestResponse } from '../application/ports.ts';

/** Receipts live in the key's tenant under RLS, like every other tenant row. */
export const createSqlIngestReceipts = (sql: SqlClient): IngestReceipts => ({
  claim: (tenantId, keyId, key, at) =>
    withTenant(sql, tenantId, async (tx) => {
      const [claimed] = await tx.query<{ ok: number }>(
        `INSERT INTO ingest_receipts (tenant_id, key_id, idem_key, created_at)
         VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING RETURNING 1 AS ok`,
        [tenantId, keyId, key, at],
      );
      if (claimed) return { kind: 'claimed' } as const;
      const [row] = await tx.query<{ response: IngestResponse | string | null }>(
        'SELECT response FROM ingest_receipts WHERE tenant_id = $1 AND key_id = $2 AND idem_key = $3',
        [tenantId, keyId, key],
      );
      if (!row?.response) return { kind: 'in_progress' } as const;
      const response =
        typeof row.response === 'string'
          ? (JSON.parse(row.response) as IngestResponse)
          : row.response;
      return { kind: 'stored', response } as const;
    }),

  complete: (tenantId, keyId, key, response) =>
    withTenant(sql, tenantId, async (tx) => {
      await tx.query(
        `UPDATE ingest_receipts SET response = $4::jsonb
         WHERE tenant_id = $1 AND key_id = $2 AND idem_key = $3`,
        [tenantId, keyId, key, JSON.stringify(response)],
      );
    }),

  release: (tenantId, keyId, key) =>
    withTenant(sql, tenantId, async (tx) => {
      await tx.query(
        'DELETE FROM ingest_receipts WHERE tenant_id = $1 AND key_id = $2 AND idem_key = $3',
        [tenantId, keyId, key],
      );
    }),
});
