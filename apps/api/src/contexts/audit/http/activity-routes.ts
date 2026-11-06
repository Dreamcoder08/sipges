import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { streamSSE } from 'hono/streaming';
import { SESSION_COOKIE } from '../../../platform/http/cookies.ts';
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
/** Whether this session token still opens this project: its session and its grant, read fresh. */
export type ActivityAccess = (token: string | undefined, tenantId: string) => Promise<boolean>;

const DEFAULTS: ActivityOptions = { pollMs: 10_000, maxMs: 240_000, heartbeatMs: 25_000 };
const BATCH = 100;

/**
 * Server-sent events with the project's activity (docs/adr/0014 §10) so open screens refresh
 * themselves. Each event names only the module and action, never a record id or detail, so
 * every role may listen without learning about records it cannot see. Those names still belong
 * to the project, so the session and the grant are read again before every poll: a logout, an
 * expired session, a deactivated account or a revoked grant ends the stream within one poll, and
 * the browser's reconnection then meets the gates. Same order as apps/api-go audit/http/activity.go.
 */
export const activityRoutes = (
  audit: AuditService,
  stillAllowed: ActivityAccess,
  options: Partial<ActivityOptions> = {},
) => {
  const { pollMs, maxMs, heartbeatMs } = { ...DEFAULTS, ...options };
  return new Hono<AppEnv>().get(ACTIVITY_PATH, (c) => {
    const tenantId = formatScope(c.get('scope'));
    const token = getCookie(c, SESSION_COOKIE);
    const resume = Number(c.req.header('last-event-id'));
    return streamSSE(c, async (stream) => {
      let cursor =
        Number.isSafeInteger(resume) && resume >= 0 ? resume : await audit.lastId(tenantId);
      await stream.writeSSE({ event: 'ready', data: '{}', id: String(cursor) });
      const deadline = Date.now() + maxMs;
      let quiet = 0;
      while (!stream.aborted && Date.now() < deadline) {
        if (!(await stillAllowed(token, tenantId))) return;
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
