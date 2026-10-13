import type { ErrorResponse } from '@mascli/contracts';
import { Hono } from 'hono';
import type { Container } from './compose.ts';
import { roleGate, sessionMiddleware } from './contexts/identity/http/auth-middleware.ts';
import { tenancyMiddleware } from './contexts/tenancy/http/tenancy-middleware.ts';
import { tenancyRoutes } from './contexts/tenancy/http/tenancy-routes.ts';
import { authRoutes } from './contexts/identity/http/auth-routes.ts';
import { healthRoutes } from './contexts/system/http/health.routes.ts';
import type { AppEnv } from './platform/http/env.ts';
import { securityHeaders } from './platform/http/security-headers.ts';

/** Builds the HTTP application from an already-wired container (no I/O here). */
export const createApp = (container: Container) => {
  const { config, identity, tenancy, clientIp } = container;
  const app = new Hono<AppEnv>();

  app.use('*', securityHeaders({ hsts: config.cookieSecure }));
  app.use('*', sessionMiddleware(identity));
  app.use('*', tenancyMiddleware(tenancy));
  app.use('*', roleGate(identity));

  app.route('/', healthRoutes());
  app.route('/', tenancyRoutes({ tenancy, identity, cookieSecure: config.cookieSecure }));
  app.route('/', authRoutes({ identity, cookieSecure: config.cookieSecure, clientIp }));

  app.notFound((c) => c.json({ detail: 'Not Found' } satisfies ErrorResponse, 404));
  app.onError((error, c) => {
    console.error(error);
    return c.json({ detail: 'Internal Server Error' } satisfies ErrorResponse, 500);
  });

  return app;
};
