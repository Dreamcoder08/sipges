import { Hono } from 'hono';
import type { AppEnv } from '../../../platform/http/env.ts';
import type { ConflictRiskService } from '../application/index.ts';

/** GET /system/conflict-risk (docs/adr/0031): always for the scope the tenancy middleware resolved. */
export const conflictRiskRoutes = (deps: { conflictRisk: ConflictRiskService }) =>
  new Hono<AppEnv>().get('/system/conflict-risk', async (c) =>
    c.json(await deps.conflictRisk.predict(c.get('scope'))),
  );
