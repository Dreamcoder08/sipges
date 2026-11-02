import { Hono } from 'hono';
import type { AppEnv } from './env.ts';
import { hostAllowlist } from './host.ts';
import { requestContext } from './request-context.ts';
import { securityHeaders } from './security-headers.ts';
import { type WebAssets, spaMiddleware } from './spa.ts';

/**
 * The SPA half of createApp, with the same request context, security headers, host allowlist
 * and SPA middleware in the same order, but no container: it never touches the database.
 * Hosts route only isSpaRequest() requests here, so the first load does not wait on the API.
 */
export const createWebApp = (options: {
  readonly allowedHosts: readonly string[];
  readonly hsts: boolean;
  readonly web: WebAssets;
}) => {
  const app = new Hono<AppEnv>();
  app.use('*', requestContext());
  app.use('*', securityHeaders({ hsts: options.hsts }));
  app.use('*', hostAllowlist(options.allowedHosts));
  app.use('*', spaMiddleware(options.web));
  app.notFound((c) => c.json({ detail: 'Not Found' }, 404));
  return app;
};
