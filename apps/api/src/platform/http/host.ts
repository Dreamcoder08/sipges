import type { MiddlewareHandler } from 'hono';

/** Host name of a Host header value, without port; IPv6 literals keep their brackets. */
export const hostName = (header: string | undefined): string => {
  const value = (header ?? '').trim().toLowerCase();
  if (value.startsWith('[')) return value.slice(0, value.indexOf(']') + 1);
  return value.split(':')[0] ?? '';
};

/**
 * Rejects requests whose Host is not an expected public name (DNS rebinding, host-header
 * poisoning). Disabled when the allowlist is empty, e.g. local development (ADR 0009).
 */
export const hostAllowlist =
  (allowed: readonly string[]): MiddlewareHandler =>
  async (c, next) => {
    if (allowed.length > 0 && !allowed.includes(hostName(c.req.header('host')))) {
      return c.json({ detail: 'Host no permitido' }, 400);
    }
    return next();
  };
