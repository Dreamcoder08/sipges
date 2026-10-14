import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Per-request values that infrastructure needs without threading them through every port:
 * the request id for logs and the authenticated actor recorded in record history (ADR 0011).
 */
export type RequestContext = { readonly requestId: string; actor: string | null };

const storage = new AsyncLocalStorage<RequestContext>();

export const runWithRequestContext = <T>(context: RequestContext, fn: () => T): T =>
  storage.run(context, fn);

export const currentRequestContext = (): RequestContext | undefined => storage.getStore();
