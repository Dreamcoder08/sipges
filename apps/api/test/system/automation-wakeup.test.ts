import { expect, it } from 'vitest';
import { Hono } from 'hono';
import type { AutomationRuntime } from '../../src/contexts/system/application/index.ts';
import type { AppEnv } from '../../src/platform/http/env.ts';
import { automationWakeup } from '../../src/platform/http/automation-wakeup.ts';
import { DEFAULT_SCOPE, formatScope } from '../../src/contexts/tenancy/application/index.ts';
it('wakes only committed scoped business writes and authenticated nonreplayed ingestion', async () => {
  const called: string[] = [];
  const runtime = {
    dispatch: async (tenant: string) => {
      called.push(tenant);
    },
  } as AutomationRuntime;
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    if (!c.req.path.startsWith('/hooks/')) c.set('scope', DEFAULT_SCOPE);
    await next();
  });
  app.use('*', automationWakeup(runtime));
  app.post('/api/narrativas', (c) => c.json({ ok: true }, 201));
  app.post('/api/failure', (c) => c.json({ detail: 'bad' }, 400));
  app.get('/api/narrativas', (c) => c.json([]));
  app.post('/system/notifications/push/test', (c) => c.json({ ok: true }));
  app.post('/hooks/ingest/narrativas', (c) => {
    if (c.req.header('x-test-committed')) c.set('automationTenant', 'B/project');
    return c.json({ ok: true });
  });
  await app.request('/api/narrativas', { method: 'POST' });
  await app.request('/api/failure', { method: 'POST' });
  await app.request('/api/narrativas');
  await app.request('/system/notifications/push/test', { method: 'POST' });
  await app.request('/hooks/ingest/narrativas', { method: 'POST' });
  await app.request('/hooks/ingest/narrativas', {
    method: 'POST',
    headers: { 'x-test-committed': '1' },
  });
  expect(called).toEqual([formatScope(DEFAULT_SCOPE), 'B/project']);
});
