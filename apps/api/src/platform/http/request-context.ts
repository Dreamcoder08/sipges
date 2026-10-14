import { randomUUID } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import { formatTraceparent, startTrace } from '../observability/trace.ts';
import { runWithRequestContext } from '../request-context.ts';
import type { AppEnv } from './env.ts';

/** A caller-supplied id is kept only when it cannot smuggle anything into logs. */
const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{8,64}$/;

/** Opens the request context (request id, trace, actor) that the rest of the pipeline fills in. */
export const requestContext = (): MiddlewareHandler<AppEnv> => async (c, next) => {
  const incoming = c.req.header('x-request-id');
  const requestId = incoming && SAFE_REQUEST_ID.test(incoming) ? incoming : randomUUID();
  const trace = startTrace(c.req.header('traceparent'));
  c.header('X-Request-Id', requestId);
  // Trace Context Level 2: tells the caller which trace and span served the request.
  c.header('traceresponse', formatTraceparent(trace));
  await runWithRequestContext({ requestId, trace, actor: null, clearance: 'limited' }, () =>
    next(),
  );
};
