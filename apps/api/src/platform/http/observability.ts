import type { Context, MiddlewareHandler } from 'hono';
import { log } from '../observability/logger.ts';
import type { Metrics } from '../observability/metrics.ts';
import type { AppEnv } from './env.ts';

/** The matched route pattern (e.g. /api/:module/:id), never the raw path. */
const routeOf = (c: Context) =>
  c.req.matchedRoutes.filter((route) => route.method !== 'ALL').at(-1)?.path ?? 'unmatched';

/**
 * Times every request: a Server-Timing header for the browser's devtools, a metrics sample
 * and, when enabled, one structured access-log line (no query string, body or cookies).
 */
export const observability =
  (metrics: Metrics, options: { accessLog: boolean }): MiddlewareHandler<AppEnv> =>
  async (c, next) => {
    const started = performance.now();
    await next();
    const elapsed = performance.now() - started;
    const route = routeOf(c);
    try {
      c.res.headers.set('Server-Timing', `app;dur=${elapsed.toFixed(1)}`);
    } catch {
      // Some responses (e.g. proxied fetches) have immutable headers; timing is optional.
    }
    metrics.observe(c.req.method, route, c.res.status, elapsed / 1000);
    if (options.accessLog) {
      log('info', 'request', {
        method: c.req.method,
        route,
        path: c.req.path,
        status: c.res.status,
        duration_ms: Number(elapsed.toFixed(1)),
      });
    }
  };
