import { Hono } from 'hono';
import type { AppEnv } from '../../../platform/http/env.ts';
import type { ReferenceService } from '../application/index.ts';
export const referenceRoutes = (reference: ReferenceService) =>
  new Hono<AppEnv>()
    .get('/system/project-coordinates', async (c) =>
      c.json(await reference.coordinates(c.get('scope'))),
    )
    .get('/system/canonical-entities', async (c) =>
      c.json(await reference.entities(c.get('scope'))),
    );
