import type { HealthResponse } from '@sipges/contracts';
import { Hono } from 'hono';

const HEALTH: HealthResponse = { status: 'ok', service: 'SIPGES', version: 'V0.5.1' };

/** A slow database counts as down: the deploy smoke test must not hang on it. */
const READY_TIMEOUT_MS = 5000;

const withTimeout = (work: Promise<void>, ms: number) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('readiness timeout')), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
};

/**
 * `/health` is liveness and stays static. `/health/ready` proves the database answers; the
 * deploy workflow smoke-tests it and rolls back on failure (docs/deployment/cloudflare-workers.md).
 */
export const healthRoutes = (options?: {
  ready?: () => Promise<void>;
  timeoutMs?: number;
}) => {
  const app = new Hono().get('/health', (c) => c.json(HEALTH));
  const ready = options?.ready;
  if (!ready) return app;
  return app.get('/health/ready', async (c) => {
    try {
      await withTimeout(ready(), options?.timeoutMs ?? READY_TIMEOUT_MS);
      return c.json({ status: 'ready' });
    } catch {
      // The cause may carry a connection string: it is never echoed or logged here.
      return c.json({ status: 'unavailable' }, 503);
    }
  });
};
