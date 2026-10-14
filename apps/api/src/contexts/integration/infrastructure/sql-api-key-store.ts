import { appendAudit } from '../../../platform/database/audit-trail.ts';
import type { SqlClient } from '../../../platform/database/sql-client.ts';
import type { ApiKeyStore, StoredKey } from '../application/ports.ts';
import type { KeyAccess, KeyClearance } from '../domain/api-key.ts';

const AUDIT_MODULE = 'Integraciones';

type KeyRow = {
  id: number;
  tenant_id: string;
  name: string;
  prefix: string;
  secret_hash: string;
  access: KeyAccess;
  clearance: KeyClearance;
  created_by: string;
  created_at: Date | string;
  last_used_at: Date | string | null;
  revoked_at: Date | string | null;
};

const date = (value: Date | string | null) => (value === null ? null : new Date(value));

const toKey = (row: KeyRow): StoredKey => ({
  id: Number(row.id),
  name: row.name,
  prefix: row.prefix,
  access: row.access,
  clearance: row.clearance,
  createdBy: row.created_by,
  createdAt: new Date(row.created_at),
  lastUsedAt: date(row.last_used_at),
  revokedAt: date(row.revoked_at),
});

/**
 * api_keys is a global table the tenant role cannot read (like sessions); it is reached with
 * the owner connection and always filtered by tenant. Creation and revocation are audited in
 * the tenant's own trail, in the same transaction.
 */
export const createSqlApiKeyStore = (sql: SqlClient): ApiKeyStore => ({
  create: (tenantId, key, actor, at) =>
    sql.transaction(async (tx) => {
      const [row] = await tx.query<{ id: number }>(
        `INSERT INTO api_keys (tenant_id, name, prefix, secret_hash, access, clearance, created_by, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (tenant_id, name) DO NOTHING RETURNING id`,
        [tenantId, key.name, key.prefix, key.secretHash, key.access, key.clearance, actor, at],
      );
      if (!row) return { ok: false, error: 'duplicate' } as const;
      await audited(
        tx,
        tenantId,
        `clave-${row.id}`,
        'CREATE',
        `Clave de API «${key.name}» (${key.access}, ${key.clearance}) ${key.prefix}`,
        at,
      );
      return { ok: true, id: Number(row.id) } as const;
    }),

  list: async (tenantId) =>
    (
      await sql.query<KeyRow>(
        `SELECT id, tenant_id, name, prefix, secret_hash, access, clearance, created_by, created_at,
                last_used_at, revoked_at
         FROM api_keys WHERE tenant_id = $1 ORDER BY revoked_at IS NOT NULL, name, id`,
        [tenantId],
      )
    ).map(toKey),

  revoke: (tenantId, id, at) =>
    sql.transaction(async (tx) => {
      const [row] = await tx.query<{ name: string }>(
        `UPDATE api_keys SET revoked_at = $3
         WHERE tenant_id = $1 AND id = $2 AND revoked_at IS NULL RETURNING name`,
        [tenantId, id, at],
      );
      if (!row) return false;
      await audited(
        tx,
        tenantId,
        `clave-${id}`,
        'DELETE',
        `Clave de API «${row.name}» revocada`,
        at,
      );
      return true;
    }),

  active: async (prefix) => {
    const [row] = await sql.query<KeyRow>(
      `SELECT id, tenant_id, name, prefix, secret_hash, access, clearance, created_by, created_at,
              last_used_at, revoked_at
       FROM api_keys WHERE prefix = $1 AND revoked_at IS NULL`,
      [prefix],
    );
    return row
      ? {
          keyId: Number(row.id),
          tenantId: row.tenant_id,
          name: row.name,
          access: row.access,
          clearance: row.clearance,
          secretHash: row.secret_hash,
          lastUsedAt: date(row.last_used_at),
        }
      : null;
  },

  touch: async (id, at) => {
    await sql.query('UPDATE api_keys SET last_used_at = $2 WHERE id = $1', [id, at]);
  },
});

/** Appends the audit row as the tenant role inside the caller's transaction. */
const audited = async (
  tx: SqlClient,
  tenantId: string,
  recordId: string,
  action: string,
  detail: string,
  at: Date,
) => {
  await tx.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
  await appendAudit(tx, { module: AUDIT_MODULE, recordId, action, detail, at });
};
