import type { ErrorResponse } from '@mascli/contracts';
import { Hono } from 'hono';
import { healthRoutes } from './contexts/system/http/health.routes.ts';
import type { AppConfig } from './platform/config.ts';
import { securityHeaders } from './platform/http/security-headers.ts';

export type AppDeps = {
  readonly config: AppConfig;
};

/** Builds the HTTP application from already-constructed dependencies (no I/O here). */
export const createApp = (_deps: AppDeps) => {
  const app = new Hono();

  app.use('*', securityHeaders());
  app.route('/', healthRoutes());

  app.notFound((c) => c.json({ detail: 'Not Found' } satisfies ErrorResponse, 404));
  app.onError((error, c) => {
    console.error(error);
    return c.json({ detail: 'Internal Server Error' } satisfies ErrorResponse, 500);
  });

  return app;
};
