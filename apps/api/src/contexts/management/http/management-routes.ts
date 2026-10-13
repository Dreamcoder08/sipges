import { Hono } from 'hono';
import type { AppEnv } from '../../../platform/http/env.ts';
import { MANAGEMENT_CSV_FILENAME, type ManagementService } from '../application/index.ts';

/** Management center (app.py:2260-2270) for the active scope's project. */
export const managementRoutes = (management: ManagementService) =>
  new Hono<AppEnv>()
    .get('/system/management/overview', async (c) =>
      c.json(await management.overview(c.get('scope'))),
    )
    .get('/system/management/report.csv', async (c) =>
      c.body(await management.csv(c.get('scope')), 200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${MANAGEMENT_CSV_FILENAME}"`,
      }),
    );
