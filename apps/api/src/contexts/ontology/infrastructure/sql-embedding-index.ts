import type { SqlClient } from '../../../platform/database/sql-client.ts';
import { withTenant } from '../../../platform/database/tenant-transaction.ts';
import type { EmbeddingIndex } from '../application/ports.ts';

const vectorOf = (value: unknown): number[] =>
  Array.isArray(value)
    ? value.map(Number)
    : // node-postgres returns real[] parsed; PGlite may return the text form "{0.1,0.2}".
      String(value).replace(/[{}]/g, '').split(',').map(Number);

export const createSqlEmbeddingIndex = (sql: SqlClient): EmbeddingIndex => ({
  stale: (tenantId, model, limit) =>
    withTenant(sql, tenantId, (tx) =>
      tx.query<{ module: string; id: string; payload: Record<string, unknown>; hash: string }>(
        `SELECT r.module, r.id, r.payload, md5(r.payload::text) AS hash FROM module_records r
         LEFT JOIN record_embeddings e
           ON e.tenant_id = r.tenant_id AND e.module = r.module AND e.id = r.id
         WHERE r.marking <> 'restringido'
           AND (e.id IS NULL OR e.model <> $1 OR e.source_hash <> md5(r.payload::text))
         ORDER BY r.updated_at, r.module, r.id LIMIT $2`,
        [model, limit],
      ),
    ),

  save: (tenantId, rows, model, at) =>
    withTenant(sql, tenantId, async (tx) => {
      for (const row of rows) {
        await tx.query(
          // The hash is of the payload that was read; a concurrent edit makes it stale again.
          `INSERT INTO record_embeddings
             (tenant_id, module, id, model, vector, source_hash, embedded_at)
           VALUES ($1, $2, $3, $4, $5::real[], $6, $7)
           ON CONFLICT (tenant_id, module, id)
           DO UPDATE SET model = EXCLUDED.model, vector = EXCLUDED.vector,
                         source_hash = EXCLUDED.source_hash, embedded_at = EXCLUDED.embedded_at`,
          [tenantId, row.module, row.id, model, `{${row.vector.join(',')}}`, row.hash, at],
        );
      }
    }),

  vectors: (tenantId, modules, model, limit) =>
    withTenant(sql, tenantId, async (tx) =>
      (
        await tx.query<{ module: string; id: string; vector: unknown }>(
          // The join applies module_records' visibility policy to the embeddings.
          `SELECT e.module, e.id, e.vector FROM record_embeddings e
           JOIN module_records r ON r.tenant_id = e.tenant_id AND r.module = e.module AND r.id = e.id
           WHERE e.model = $1 AND e.module = ANY($2::text[])
           ORDER BY r.updated_at DESC LIMIT $3`,
          [model, [...modules], limit],
        )
      ).map((row) => ({ module: row.module, id: row.id, vector: vectorOf(row.vector) })),
    ),
});
