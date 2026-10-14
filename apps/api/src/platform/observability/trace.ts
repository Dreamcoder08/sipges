import { randomBytes } from 'node:crypto';
import { type Trace, currentRequestContext } from '../request-context.ts';

/**
 * W3C Trace Context (https://www.w3.org/TR/trace-context/): the request joins the caller's
 * trace when it sends a valid `traceparent`, otherwise starts one; logs carry the ids and
 * outbound calls continue the trace with a new span (docs/adr/0014 §10).
 */
export type { Trace };

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const ZERO_TRACE = '0'.repeat(32);
const ZERO_SPAN = '0'.repeat(16);

const spanId = () => randomBytes(8).toString('hex');

/** The caller's trace id and flags, or null for a missing, malformed or all-zero header. */
export const parseTraceparent = (
  header: string | undefined,
): { traceId: string; flags: string } | null => {
  const match = TRACEPARENT.exec((header ?? '').trim());
  if (!match) return null;
  const [, traceId = '', parent = '', flags = '00'] = match;
  return traceId === ZERO_TRACE || parent === ZERO_SPAN ? null : { traceId, flags };
};

/** This service's span within the caller's trace, or the root span of a new sampled trace. */
export const startTrace = (header: string | undefined): Trace => {
  const parent = parseTraceparent(header);
  return {
    traceId: parent?.traceId ?? randomBytes(16).toString('hex'),
    spanId: spanId(),
    flags: parent?.flags ?? '01',
  };
};

export const formatTraceparent = (trace: Trace) =>
  `00-${trace.traceId}-${trace.spanId}-${trace.flags}`;

/**
 * Header for an outbound call: a child span of the current request, or a fresh trace for
 * background work such as automation ticks.
 */
export const outboundTraceHeaders = (): { traceparent: string } => {
  const current = currentRequestContext()?.trace;
  return {
    traceparent: formatTraceparent({
      traceId: current?.traceId ?? randomBytes(16).toString('hex'),
      spanId: spanId(),
      flags: current?.flags ?? '01',
    }),
  };
};
