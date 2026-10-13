import type { SqlClient } from '../../../platform/database/sql-client.ts';
import { appendAudit } from '../../../platform/database/audit-trail.ts';
import { withTenant } from '../../../platform/database/tenant-transaction.ts';
import type { IrsaSnapshot, IrsaSnapshotStore } from '../application/ports.ts';
import { isoSeconds } from '../../../platform/http/time.ts';
import { jsonValue } from './json-value.ts';

type Row = {
  id: number | string | bigint;
  ts: Date | string;
  irsa: number | string;
  level: string;
  scores: unknown;
  config_version: string | null;
  note: string | null;
};

const toSnapshot = (row: Row): IrsaSnapshot => ({
  id: Number(row.id),
  ts: isoSeconds(new Date(row.ts)),
  irsa: Number(row.irsa),
  level: row.level,
  scores: jsonValue<Record<string, number>>(row.scores),
  config_version: row.config_version,
  note: row.note,
});

export const createSqlIrsaSnapshotStore = (sql: SqlClient): IrsaSnapshotStore => ({
  insert: (tenantId, s) =>
    withTenant(sql, tenantId, async (tx) => {
      const [row] = await tx.query<{ id: number | string | bigint }>(
        `INSERT INTO irsa_snapshots (tenant_id, ts, irsa, level, scores, config_version, note)
         VALUES ($1, $2, $3, $4, $5::json, $6, $7) RETURNING id`,
        [
          tenantId,
          s.ts.toISOString(),
          s.irsa,
          s.level,
          JSON.stringify(s.scores),
          s.configVersion,
          s.note,
        ],
      );
      if (!row) throw new Error('IRSA snapshot insert returned no id');
      const id = Number(row.id);
      await appendAudit(tx, {
        module: 'IRSA',
        recordId: String(id),
        action: 'SNAPSHOT',
        detail: s.auditDetail,
        at: s.ts,
      });
      return id;
    }),
  list: (tenantId, limit) =>
    withTenant(sql, tenantId, async (tx) =>
      (
        await tx.query<Row>(
          `SELECT id, ts, irsa, level, scores, config_version, note FROM irsa_snapshots
            WHERE tenant_id = $1 ORDER BY id DESC LIMIT $2`,
          [tenantId, limit],
        )
      ).map(toSnapshot),
    ),
});
