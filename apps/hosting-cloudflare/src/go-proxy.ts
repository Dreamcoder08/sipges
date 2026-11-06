import { Hono } from 'hono';
import type { AppEnv } from '../../api/src/platform/http/env.ts';
import { hostAllowlist } from '../../api/src/platform/http/host.ts';
import { requestContext } from '../../api/src/platform/http/request-context.ts';
import { securityHeaders } from '../../api/src/platform/http/security-headers.ts';

const UNAVAILABLE = { detail: 'SIPGES no está disponible temporalmente' };

/**
 * Go answers every failure as JSON. @cloudflare/containers 0.3.7 returns plain text instead of
 * throwing when the container cannot start, is rate limited or drops the connection (429 and 5xx,
 * some carrying an internal message), so a failure that is not JSON did not come from Go.
 */
const isContainerFailure = (response: Response) =>
  (response.status === 429 || response.status >= 500) &&
  !/^application\/json\b/i.test(response.headers.get('content-type') ?? '');

/**
 * The edge half of a Go-served route: the same request context, security headers and host
 * allowlist as the TypeScript API (createApp, createWebApp), then the Go container. Responses
 * keep Go's status and body; the headers the browser relies on stay the Worker's. A container
 * failure, thrown or returned, becomes the Worker's own 503.
 */
export const createGoProxy = (options: {
  readonly allowedHosts: readonly string[];
  readonly hsts: boolean;
  readonly forward: (request: Request) => Promise<Response>;
}) => {
  const app = new Hono<AppEnv>();
  app.use('*', requestContext());
  app.use('*', securityHeaders({ hsts: options.hsts }));
  app.use('*', hostAllowlist(options.allowedHosts));
  app.all('*', async (c) => {
    try {
      const response = await options.forward(c.req.raw);
      if (isContainerFailure(response)) {
        // Only the status is logged: the body may carry the internal message.
        console.error('Go container unavailable', { status: response.status });
        await response.body?.cancel();
        return c.json(UNAVAILABLE, 503);
      }
      // Durable Object responses have immutable headers; the middleware above adds to them.
      return new Response(response.body, response);
    } catch (error) {
      // A container that fails to start or to open its port surfaces here. Only the error
      // class is logged: messages may carry connection strings.
      console.error('Go container unavailable', {
        kind: error instanceof Error ? error.name : typeof error,
      });
      return c.json(UNAVAILABLE, 503);
    }
  });
  return app;
};
