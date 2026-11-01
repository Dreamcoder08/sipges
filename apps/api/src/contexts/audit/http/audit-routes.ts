import type { AuditEntry } from '@sipges/contracts';
import { Hono } from 'hono';
import type { AppEnv } from '../../../platform/http/env.ts';
import { isoSeconds } from '../../../platform/http/time.ts';
import { parseIntQuery } from '../../../platform/http/validation.ts';
import { formatScope } from '../../tenancy/application/index.ts';
import type { AuditService } from '../application/index.ts';

/** GET /system/audit (app.py audit): admin-only via roleGate, newest first, active tenant only. */
export const auditRoutes = (audit: AuditService) =>
  new Hono<AppEnv>().get('/system/audit', async (c) => {
    const limit = parseIntQuery(c, 'limit', 100);
    if (!limit.ok) return limit.response;
    const entries = await audit.latest(formatScope(c.get('scope')), limit.value);
    return c.json(
      entries.map((entry): AuditEntry => ({
        id: entry.id,
        ts: isoSeconds(entry.at),
        module: entry.module,
        record_id: entry.recordId,
        action: entry.action,
        detail: entry.detail,
      })),
    );
  });
