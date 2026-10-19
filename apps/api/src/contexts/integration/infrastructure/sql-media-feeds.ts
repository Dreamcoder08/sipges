import type { MediaFeed } from '@mascli/contracts';
import { appendAudit } from '../../../platform/database/audit-trail.ts';
import type { SqlClient } from '../../../platform/database/sql-client.ts';
import { withTenant } from '../../../platform/database/tenant-transaction.ts';
import { MAX_FEEDS, type FeedWrite, type MediaFeedStore } from '../application/media-monitor.ts';

type Row = Omit<MediaFeed, 'keywords' | 'updated_at' | 'last_poll_at'> & {
  keywords: string[] | string;
  updated_at: Date | string;
  last_poll_at: Date | string | null;
};

const COLUMNS =
  'id,name,url,keywords,territory,authorization_note,enabled,updated_by,updated_at,last_poll_at,last_poll_error,last_imported,last_matched';

const mapped = (row: Row): MediaFeed => ({
  ...row,
  keywords: typeof row.keywords === 'string' ? JSON.parse(row.keywords) : row.keywords,
  updated_at: new Date(row.updated_at).toISOString(),
  last_poll_at: row.last_poll_at ? new Date(row.last_poll_at).toISOString() : null,
});

const isUniqueViolation = (error: unknown) =>
  typeof error === 'object' && error !== null && (error as { code?: string }).code === '23505';

const audit = (tx: SqlClient, detail: string, at: string) =>
  appendAudit(tx, {
    module: 'Monitoreo de medios',
    recordId: null,
    action: 'CONFIG_UPDATE',
    detail,
    at: new Date(at),
  });

export const createSqlMediaFeeds = (sql: SqlClient): MediaFeedStore => ({
  list: (tenantId) =>
    withTenant(sql, tenantId, async (tx) =>
      (
        await tx.query<Row>(`SELECT ${COLUMNS} FROM media_feeds WHERE tenant_id=$1 ORDER BY id`, [
          tenantId,
        ])
      ).map(mapped),
    ),
  create: async (tenantId, feed: FeedWrite) => {
    try {
      return await withTenant(sql, tenantId, async (tx) => {
        const [count] = await tx.query<{ n: number | string }>(
          'SELECT count(*) AS n FROM media_feeds WHERE tenant_id=$1',
          [tenantId],
        );
        if (Number(count?.n ?? 0) >= MAX_FEEDS) return 'limit' as const;
        const [row] = await tx.query<Row>(
          `INSERT INTO media_feeds (tenant_id,name,url,keywords,territory,authorization_note,enabled,updated_by,updated_at)
           VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9) RETURNING ${COLUMNS}`,
          [
            tenantId,
            feed.name,
            feed.url,
            JSON.stringify(feed.keywords),
            feed.territory,
            feed.authorization_note,
            feed.enabled,
            feed.actor,
            feed.at,
          ],
        );
        // The cron visits tenants with an automation cursor; start at the current audit head,
        // as the Defensoría connector does, so no history is replayed.
        await tx.query(
          `INSERT INTO automation_cursors (tenant_id, last_audit_id)
           SELECT current_setting('app.tenant_id', true), COALESCE(max(id), 0) FROM audit
           ON CONFLICT (tenant_id) DO NOTHING`,
        );
        if (!row) throw new Error('media_feed_not_created');
        await audit(tx, `Fuente agregada: ${feed.name} (${feed.url})`, feed.at);
        return mapped(row);
      });
    } catch (error) {
      if (isUniqueViolation(error)) return 'duplicate';
      throw error;
    }
  },
  update: async (tenantId, id, feed) => {
    try {
      return await withTenant(sql, tenantId, async (tx) => {
        const [row] = await tx.query<Row>(
          `UPDATE media_feeds SET name=$3,url=$4,keywords=$5::jsonb,territory=$6,authorization_note=$7,
             enabled=$8,updated_by=$9,updated_at=$10
           WHERE tenant_id=$1 AND id=$2 RETURNING ${COLUMNS}`,
          [
            tenantId,
            id,
            feed.name,
            feed.url,
            JSON.stringify(feed.keywords),
            feed.territory,
            feed.authorization_note,
            feed.enabled,
            feed.actor,
            feed.at,
          ],
        );
        if (!row) return null;
        await audit(
          tx,
          `Fuente ${feed.enabled ? 'actualizada' : 'pausada'}: ${feed.name} (${feed.url})`,
          feed.at,
        );
        return mapped(row);
      });
    } catch (error) {
      if (isUniqueViolation(error)) return 'duplicate';
      throw error;
    }
  },
  remove: (tenantId, id, _actor, at) =>
    withTenant(sql, tenantId, async (tx) => {
      const [row] = await tx.query<{ name: string; url: string }>(
        'DELETE FROM media_feeds WHERE tenant_id=$1 AND id=$2 RETURNING name, url',
        [tenantId, id],
      );
      if (!row) return false;
      await audit(tx, `Fuente eliminada: ${row.name} (${row.url})`, at);
      return true;
    }),
  claimDue: (tenantId, at, minutes) =>
    withTenant(sql, tenantId, async (tx) =>
      (
        await tx.query<Row>(
          `UPDATE media_feeds SET last_poll_at=$2
           WHERE tenant_id=$1 AND enabled
             AND (last_poll_at IS NULL OR last_poll_at <= $2::timestamptz - make_interval(mins => $3))
           RETURNING ${COLUMNS}`,
          [tenantId, at, minutes],
        )
      )
        .map(mapped)
        .sort((a, b) => a.id - b.id),
    ),
  finish: (tenantId, id, at, outcome) =>
    withTenant(sql, tenantId, async (tx) => {
      await tx.query(
        `UPDATE media_feeds SET last_poll_error=$4,last_imported=$5,last_matched=$6
         WHERE tenant_id=$1 AND id=$2 AND last_poll_at=$3`,
        [tenantId, id, at, outcome.error, outcome.imported, outcome.matched],
      );
    }),
});
