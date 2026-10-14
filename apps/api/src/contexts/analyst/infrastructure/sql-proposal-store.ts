import { appendAudit } from '../../../platform/database/audit-trail.ts';
import type { SqlClient } from '../../../platform/database/sql-client.ts';
import { withTenant } from '../../../platform/database/tenant-transaction.ts';
import type { ProposalStore } from '../application/index.ts';

/** Audit module of proposal decisions; automation rules may react to it like any module. */
const AUDIT_MODULE = 'Analista';

export const createSqlProposalStore = (sql: SqlClient): ProposalStore => ({
  decided: async (tenantId, fingerprints) => {
    if (!fingerprints.length) return new Set();
    const rows = await withTenant(sql, tenantId, (tx) =>
      tx.query<{ fingerprint: string }>(
        'SELECT fingerprint FROM proposal_decisions WHERE fingerprint = ANY($1::text[])',
        [[...fingerprints]],
      ),
    );
    return new Set(rows.map((row) => row.fingerprint));
  },

  save: (tenantId, d) =>
    withTenant(sql, tenantId, async (tx) => {
      const [row] = await tx.query<{ ok: number }>(
        `INSERT INTO proposal_decisions
           (tenant_id, fingerprint, subject_module, subject_id, kind, decision, result, decided_by, decided_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT DO NOTHING RETURNING 1 AS ok`,
        [
          tenantId,
          d.fingerprint,
          d.subject.slug,
          d.subject.id,
          d.kind,
          d.decision,
          d.result,
          d.actor,
          d.at,
        ],
      );
      if (!row) return false;
      await appendAudit(tx, {
        module: AUDIT_MODULE,
        recordId: d.subject.id,
        action: 'REVIEW',
        detail: `${d.decision === 'approved' ? 'Aprobada' : 'Descartada'}: ${d.title}${
          d.result ? ` → ${d.result}` : ''
        }`.slice(0, 500),
        at: d.at,
      });
      return true;
    }),
});
