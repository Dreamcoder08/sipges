import { appendAudit } from '../../../platform/database/audit-trail.ts';
import type { SqlClient } from '../../../platform/database/sql-client.ts';
import { withTenant } from '../../../platform/database/tenant-transaction.ts';
import type { NodeRef, OntologyStore, StoredLink } from '../application/ports.ts';

type LinkRow = {
  id: number;
  link_type: string;
  source_module: string;
  source_id: string;
  target_module: string;
  target_id: string;
  note: string;
  created_by: string;
  created_at: Date | string;
};

const toLink = (row: LinkRow): StoredLink => ({
  id: Number(row.id),
  linkType: row.link_type,
  source: { module: row.source_module, id: row.source_id },
  target: { module: row.target_module, id: row.target_id },
  note: row.note,
  createdBy: row.created_by,
  createdAt: new Date(row.created_at),
});

const columns = (refs: readonly NodeRef[]) => [refs.map((r) => r.module), refs.map((r) => r.id)];

/** `(module, id) IN refs` over two parallel text arrays at `$first`, `$first + 1`. */
const inRefs = (moduleColumn: string, idColumn: string, first: number) =>
  `(${moduleColumn}, ${idColumn}) IN (SELECT * FROM unnest($${first}::text[], $${first + 1}::text[]))`;

const AUDIT_MODULE = 'Vinculos';

/** Links and inference read module_records and record_links under forced RLS (ADR 0011). */
export const createSqlOntologyStore = (sql: SqlClient): OntologyStore => ({
  nodes: (tenantId, refs) =>
    withTenant(sql, tenantId, async (tx) =>
      (
        await tx.query<{
          module: string;
          id: string;
          payload: Record<string, unknown>;
          updated_at: Date | string;
        }>(
          `SELECT module, id, payload, updated_at FROM module_records WHERE ${inRefs('module', 'id', 1)}`,
          columns(refs),
        )
      ).map((row) => ({ ...row, updatedAt: new Date(row.updated_at) })),
    ),

  links: (tenantId, refs) =>
    withTenant(sql, tenantId, async (tx) =>
      (
        await tx.query<LinkRow>(
          `SELECT id, link_type, source_module, source_id, target_module, target_id, note,
                  created_by, created_at
           FROM record_links
           WHERE ${inRefs('source_module', 'source_id', 1)} OR ${inRefs('target_module', 'target_id', 1)}
           ORDER BY id`,
          columns(refs),
        )
      ).map(toLink),
    ),

  inferred: (tenantId, refs, rules) =>
    rules.length === 0 || refs.length === 0
      ? Promise.resolve([])
      : withTenant(sql, tenantId, async (tx) =>
          (
            await tx.query<{
              rule: number;
              holder_module: string;
              holder_id: string;
              target_module: string;
              target_id: string;
            }>(
              `WITH rules (rule, holder, field, target, match, title_field) AS (
                 SELECT * FROM unnest($1::int[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[])
               )
               SELECT rules.rule, h.module AS holder_module, h.id AS holder_id,
                      t.module AS target_module, t.id AS target_id
               FROM rules
               JOIN module_records h
                 ON h.module = rules.holder AND COALESCE(btrim(h.payload ->> rules.field), '') <> ''
               JOIN module_records t
                 ON t.module = rules.target
                AND (h.module, h.id) <> (t.module, t.id)
                AND CASE rules.match
                      WHEN 'id' THEN t.id = btrim(h.payload ->> rules.field)
                      ELSE lower(btrim(t.payload ->> rules.title_field)) = lower(btrim(h.payload ->> rules.field))
                    END
               WHERE ${inRefs('h.module', 'h.id', 7)} OR ${inRefs('t.module', 't.id', 7)}
               ORDER BY rules.rule, h.module, h.id, t.id`,
              [
                rules.map((r) => r.index),
                rules.map((r) => r.holderModule),
                rules.map((r) => r.field),
                rules.map((r) => r.targetModule),
                rules.map((r) => r.match),
                rules.map((r) => r.targetTitleField),
                ...columns(refs),
              ],
            )
          ).map((row) => ({
            index: Number(row.rule),
            holder: { module: row.holder_module, id: row.holder_id },
            target: { module: row.target_module, id: row.target_id },
          })),
        ),

  createLink: (tenantId, link, at) =>
    withTenant(sql, tenantId, async (tx) => {
      const [present] = await tx.query<{ count: number | string }>(
        `SELECT count(*) AS count FROM module_records WHERE ${inRefs('module', 'id', 1)}`,
        columns([link.source, link.target]),
      );
      if (Number(present?.count) !== 2) return { ok: false as const, error: 'missing' as const };
      if (link.symmetric) {
        const reversed = await tx.query(
          `SELECT 1 FROM record_links WHERE link_type = $1 AND source_module = $2
             AND source_id = $3 AND target_module = $4 AND target_id = $5`,
          [link.linkType, link.target.module, link.target.id, link.source.module, link.source.id],
        );
        if (reversed.length) return { ok: false as const, error: 'duplicate' as const };
      }
      const [inserted] = await tx.query<{ id: number }>(
        `INSERT INTO record_links (tenant_id, link_type, source_module, source_id, target_module,
                                   target_id, note, created_by, created_at)
         VALUES (current_setting('app.tenant_id', true), $1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT DO NOTHING RETURNING id`,
        [
          link.linkType,
          link.source.module,
          link.source.id,
          link.target.module,
          link.target.id,
          link.note,
          link.createdBy,
          at,
        ],
      );
      if (!inserted) return { ok: false as const, error: 'duplicate' as const };
      const id = Number(inserted.id);
      await appendAudit(tx, {
        module: AUDIT_MODULE,
        recordId: String(id),
        action: 'CREATE',
        detail: `Vínculo creado: ${link.auditDetail}`,
        at,
      });
      return { ok: true as const, id };
    }),

  deleteLink: (tenantId, id, at) =>
    withTenant(sql, tenantId, async (tx) => {
      const [deleted] = await tx.query<LinkRow>(
        `DELETE FROM record_links WHERE id = $1
         RETURNING id, link_type, source_module, source_id, target_module, target_id`,
        [id],
      );
      if (!deleted) return false;
      await appendAudit(tx, {
        module: AUDIT_MODULE,
        recordId: String(id),
        action: 'DELETE',
        detail: `Vínculo eliminado: ${deleted.source_module} ${deleted.source_id} ${deleted.link_type} ${deleted.target_module} ${deleted.target_id}`,
        at,
      });
      return true;
    }),
});
