import type { MiddlewareHandler } from 'hono';

/** Response headers set by app.py enforce_auth on every response (behavior contract §2, step 10). */
export const securityHeaders = (): MiddlewareHandler => async (c, next) => {
  await next();
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Frame-Options', 'DENY');
  c.header('Referrer-Policy', 'no-referrer');
  c.header('Cache-Control', 'no-store');
};
