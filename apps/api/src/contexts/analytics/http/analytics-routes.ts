import { Hono } from 'hono';
import type { AppEnv } from '../../../platform/http/env.ts';
import type { AnalyticsService } from '../application/index.ts';

/**
 * JSON analytics endpoints (app.py). The tenancy middleware has already resolved the scope
 * and rejected a `project_id` query that differs from it, so the scope's project is used.
 */
export const analyticsRoutes = (deps: { analytics: AnalyticsService }) => {
  const { analytics } = deps;
  return new Hono<AppEnv>()
    .get('/system/situational-analysis', async (c) =>
      c.json(await analytics.situational(c.get('scope'))),
    )
    .get('/system/strategic-assessment', async (c) =>
      c.json(await analytics.strategic(c.get('scope'))),
    )
    .get('/system/consensus-engine', async (c) => c.json(await analytics.consensus(c.get('scope'))))
    .get('/system/integrated-analysis', async (c) =>
      c.json(await analytics.integrated(c.get('scope'))),
    );
};
