import { randomUUID } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import { runWithRequestContext } from '../request-context.ts';
import type { AppEnv } from './env.ts';

/** A caller-supplied id is kept only when it cannot smuggle anything into logs. */
const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{8,64}$/;

/** Opens the request context (request id, actor) that the rest of the pipeline fills in. */
export const requestContext = (): MiddlewareHandler<AppEnv> => async (c, next) => {
  const incoming = c.req.header('x-request-id');
  const requestId = incoming && SAFE_REQUEST_ID.test(incoming) ? incoming : randomUUID();
  c.header('X-Request-Id', requestId);
  await runWithRequestContext({ requestId, actor: null, clearance: 'limited' }, () => next());
};
