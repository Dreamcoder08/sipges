import { Hono } from 'hono';
import type { AppEnv } from '../../../platform/http/env.ts';
import type { AnalyticsReport, AnalyticsService } from '../application/index.ts';

const REPORT_PATHS: readonly (readonly [string, AnalyticsReport])[] = [
  ['/system/situational-report.docx', 'situational'],
  ['/system/strategic-report.docx', 'strategic'],
  ['/system/integrated-analysis.docx', 'integrated'],
  ['/system/consensus-engine.docx', 'consensus'],
];

/**
 * JSON analytics endpoints (app.py). The tenancy middleware has already resolved the scope
 * and rejected a `project_id` query that differs from it, so the scope's project is used.
 */
export const analyticsRoutes = (deps: { analytics: AnalyticsService }) => {
  const { analytics } = deps;
  const app = new Hono<AppEnv>()
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
  for (const [path, kind] of REPORT_PATHS) {
    app.get(path, async (c) => {
      const report = await analytics.report(kind, c.get('scope'));
      return c.body(new Uint8Array(report.bytes), 200, {
        'Content-Type': report.contentType,
        'Content-Disposition': `attachment; filename="${report.fileName}"`,
      });
    });
  }
  return app;
};
