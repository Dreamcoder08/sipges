import type { MiddlewareHandler } from 'hono';

/**
 * Headers from app.py enforce_auth (behavior contract §2, step 10). Python skips them on
 * middleware-exempt routes such as /health; here they are applied to every response.
 * HSTS is added when cookies are Secure, i.e. the deployment is HTTPS (ADR 0004).
 */
export const securityHeaders =
  (options: { hsts: boolean }): MiddlewareHandler =>
  async (c, next) => {
    await next();
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('X-Frame-Options', 'DENY');
    c.header('Referrer-Policy', 'no-referrer');
    c.header('Cache-Control', 'no-store');
    if (options.hsts) c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  };
