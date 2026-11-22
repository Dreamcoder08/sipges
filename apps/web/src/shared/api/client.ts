import type { z } from 'zod';

/** A non-2xx API answer; `detail` is the server's message, safe to show as text. */
export class ApiError extends Error {
  readonly status: number;
  readonly detail: string;
  readonly body: unknown;

  constructor(status: number, detail: string, body: unknown) {
    super(detail);
    this.name = 'ApiError';
    this.status = status;
    this.detail = detail;
    this.body = body;
  }
}

export const isApiError = (error: unknown, status?: number): error is ApiError =>
  error instanceof ApiError && (status === undefined || error.status === status);

const detailOf = (body: unknown, status: number) => {
  const detail =
    body !== null && typeof body === 'object' && 'detail' in body ? body.detail : undefined;
  if (typeof detail === 'string' && detail) return detail;
  // FastAPI-style validation lists (ADR 0007) are summarised, never rendered raw.
  if (Array.isArray(detail)) return 'Revise los datos enviados.';
  return status >= 500 ? 'El servicio no está disponible. Intente nuevamente.' : `Error ${status}`;
};

export type RequestBody =
  | { readonly json: unknown }
  | { readonly form: Readonly<Record<string, string>> }
  | { readonly multipart: FormData };

export type RequestOptions = {
  /** Pins an operation to the authorized scope where it was started. */
  readonly scope?: string;
  readonly method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  readonly body?: RequestBody;
  readonly signal?: AbortSignal;
  /** `manual` treats a redirect as success (POST /select-project answers 303). */
  readonly redirect?: RequestRedirect;
  /** What the caller reads back; JSON unless named (`text/event-stream` for a stream). */
  readonly accept?: string;
  /** Automatic traffic (polling): sent with BACKGROUND_HEADER, so it does not extend the session. */
  readonly background?: boolean;
};

/**
 * Marks a request the app made on its own (polling, live refresh). The Go API ends a session
 * after a stretch without user activity and does not count these requests (world-class-local T8f).
 */
export const BACKGROUND_HEADER = 'X-SIPGES-Background';

let backgroundDepth = 0;

/**
 * Runs `start` with every request it starts synchronously marked as background: TanStack Query
 * calls a refetch's queryFn synchronously from `invalidateQueries`, so wrapping that call marks
 * the refetches it triggers. A queryFn that awaits before calling `request` is not covered.
 */
export const runInBackground = <T>(start: () => T): T => {
  backgroundDepth += 1;
  try {
    return start();
  } finally {
    backgroundDepth -= 1;
  }
};

/**
 * The Go API tells, on every answer to a request whose session authenticated, the whole seconds
 * until that session expires (world-class-local T8f). Answers without it (public routes, the
 * TypeScript API, 401s) say nothing about the session.
 */
export const SESSION_REMAINING_HEADER = 'X-SIPGES-Session-Remaining';

const remainingListeners = new Set<(seconds: number) => void>();

/**
 * Called with the remaining seconds of every answer that tells them, background ones included.
 * Returns the unsubscribe function.
 */
export const onSessionRemaining = (listener: (seconds: number) => void): (() => void) => {
  remainingListeners.add(listener);
  return () => remainingListeners.delete(listener);
};

const tellRemaining = (response: Response) => {
  const value = response.headers.get(SESSION_REMAINING_HEADER);
  if (value === null || !/^\d+$/.test(value)) return;
  const seconds = Number(value);
  for (const listener of remainingListeners) listener(seconds);
};

const encode = (body: RequestBody | undefined): { body?: BodyInit; type?: string } => {
  if (!body) return {};
  if ('json' in body) return { body: JSON.stringify(body.json), type: 'application/json' };
  if ('form' in body) return { body: new URLSearchParams(body.form) };
  return { body: body.multipart };
};

/**
 * Same-origin call to the SIPGES API. The session and project live in HttpOnly cookies, so
 * the client never handles tokens; every failure becomes an ApiError.
 */
export const request = async (path: string, options: RequestOptions = {}) => {
  // Read before the first await: `runInBackground` only covers the synchronous start.
  const background = options.background === true || backgroundDepth > 0;
  const { body, type } = encode(options.body);
  const headers = new Headers({ accept: options.accept ?? 'application/json' });
  if (type) headers.set('content-type', type);
  if (options.scope) headers.set('X-SIPGES-Scope', options.scope);
  if (background) headers.set(BACKGROUND_HEADER, '1');
  const response = await fetch(path, {
    method: options.method ?? 'GET',
    credentials: 'same-origin',
    headers,
    ...(body === undefined ? {} : { body }),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.redirect ? { redirect: options.redirect } : {}),
  });
  tellRemaining(response);
  const redirected =
    options.redirect === 'manual' &&
    (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400));
  if (response.ok || redirected) return response;
  const payload: unknown = await response.json().catch(() => null);
  throw new ApiError(response.status, detailOf(payload, response.status), payload);
};

/** Calls the API and validates the JSON answer against its contract. */
export const requestJson = async <S extends z.ZodType>(
  path: string,
  schema: S,
  options: RequestOptions = {},
): Promise<z.infer<S>> => schema.parse(await (await request(path, options)).json());

export const isMfaRequired = (error: unknown): boolean =>
  isApiError(error, 403) &&
  error.body !== null &&
  typeof error.body === 'object' &&
  'mfa_required' in error.body &&
  error.body.mfa_required === true;
