import { Hono } from 'hono';
import type { AppEnv } from '../../../platform/http/env.ts';
import type { Metrics } from '../../../platform/observability/metrics.ts';

/** Prometheus scrape endpoint; administrators only (access-policy). */
export const metricsRoutes = (metrics: Metrics) =>
  new Hono<AppEnv>().get('/system/metrics', (c) =>
    c.text(metrics.render(), 200, {
      'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
      'Cache-Control': 'no-store',
    }),
  );
