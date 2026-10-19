import type { MiddlewareHandler } from 'hono';
import type { AutomationRuntime } from '../../contexts/system/application/index.ts';
import { formatScope } from '../../contexts/tenancy/application/index.ts';
import type { AppEnv } from './env.ts';
export const automationWakeup =
  (
    runtime: AutomationRuntime,
    defer?: (task: Promise<unknown>) => void,
  ): MiddlewareHandler<AppEnv> =>
  async (c, next) => {
    await next();
    if (
      !['POST', 'PUT', 'PATCH', 'DELETE'].includes(c.req.method) ||
      c.res.status < 200 ||
      c.res.status >= 300
    )
      return;
    const path = c.req.path;
    const machine = path.startsWith('/hooks/ingest/') || path === '/hooks/signals';
    const business =
      path.startsWith('/api/') ||
      path.startsWith('/system/intelligence/territorial-alerts') ||
      path.startsWith('/system/intelligence/sources/') ||
      path === '/system/v4/media/poll' ||
      path.startsWith('/system/prevention/') ||
      path.startsWith('/system/automations/rules');
    if (!machine && !business) return;
    const scope = c.get('scope');
    const tenantId = machine ? c.get('automationTenant') : scope ? formatScope(scope) : undefined;
    if (tenantId) await runtime.dispatch(tenantId, defer);
  };
