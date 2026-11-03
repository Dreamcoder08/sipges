import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { AppEnv } from '../../../platform/http/env.ts';
import { formatScope } from '../../tenancy/application/index.ts';
import type { AuditService } from '../application/index.ts';

export const ACTIVITY_PATH = '/system/events';

export type ActivityOptions = {
  /** How often the trail is read for new entries. */
  readonly pollMs: number;
  /** A stream ends after this long; the browser reconnects with Last-Event-ID. */
  readonly maxMs: number;
  /** A comment line keeps proxies from closing a quiet stream. */
  readonly heartbeatMs: number;
};

/**
 * Every poll is a tenant transaction held by each open tab; at 3 s a few tabs kept database
 * connections busy enough to delay the requests that draw a screen. 10 s still refreshes
 * "every few seconds" (ADR 0014) at a third of the load.
 */
const DEFAULTS: ActivityOptions = { pollMs: 10_000, maxMs: 240_000, heartbeatMs: 25_000 };
const BATCH = 100;

/**
 * Server-sent events with the project's activity (docs/adr/0014 §10) so open screens refresh
 * themselves. Each event names only the module and action, never a record id or detail, so
 * every role may listen without learning about records it cannot see.
 */
export const activityRoutes = (audit: AuditService, options: Partial<ActivityOptions> = {}) => {
  const { pollMs, maxMs, heartbeatMs } = { ...DEFAULTS, ...options };
  return new Hono<AppEnv>().get(ACTIVITY_PATH, (c) => {
    const tenantId = formatScope(c.get('scope'));
    const resume = Number(c.req.header('last-event-id'));
    return streamSSE(c, async (stream) => {
      let cursor =
        Number.isSafeInteger(resume) && resume >= 0 ? resume : await audit.lastId(tenantId);
      await stream.writeSSE({ event: 'ready', data: '{}', id: String(cursor) });
      const deadline = Date.now() + maxMs;
      let quiet = 0;
      while (!stream.aborted && Date.now() < deadline) {
        const entries = await audit.after(tenantId, cursor, BATCH);
        for (const entry of entries) {
          cursor = entry.id;
          await stream.writeSSE({
            event: 'activity',
            id: String(entry.id),
            data: JSON.stringify({ module: entry.module, action: entry.action }),
          });
        }
        quiet = entries.length ? 0 : quiet + pollMs;
        if (quiet >= heartbeatMs) {
          await stream.write(': ping\n\n');
          quiet = 0;
        }
        if (entries.length < BATCH) await stream.sleep(pollMs);
      }
    });
  });
};
