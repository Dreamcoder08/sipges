import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Per-request values that infrastructure needs without threading them through every port:
 * the request id for logs and the authenticated actor recorded in record history (ADR 0011).
 */
export type RequestContext = {
  readonly requestId: string;
  /** W3C trace this request belongs to; absent in background work. */
  readonly trace?: Trace;
  actor: string | null;
  /** Whether rows marked 'restringido' are visible (docs/adr/0012); limited until signed in. */
  clearance: Clearance;
};

export type Clearance = 'full' | 'limited';

/** W3C trace context of a request (see observability/trace.ts). */
export type Trace = { readonly traceId: string; readonly spanId: string; readonly flags: string };

const storage = new AsyncLocalStorage<RequestContext>();

export const runWithRequestContext = <T>(context: RequestContext, fn: () => T): T =>
  storage.run(context, fn);

export const currentRequestContext = (): RequestContext | undefined => storage.getStore();
