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

const activityListeners = new Set<() => void>();

/**
 * Requests the Go API answers without extending the session: `/system/auth/me` is public there,
 * and the audit activity stream (`/system/events`) is long-lived background traffic.
 */
const NOT_EXTENDING = new Set(['/system/auth/me', '/system/events']);
const extendsSession = (path: string) => !NOT_EXTENDING.has(path.split('?')[0] ?? path);

/**
 * Called whenever the server answers a request that extends the session: one that is not
 * background, not on a path that never extends it, and not refused as signed out. Returns the
 * unsubscribe function.
 */
export const onServerActivity = (listener: () => void): (() => void) => {
  activityListeners.add(listener);
  return () => activityListeners.delete(listener);
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
  if (!background && response.status !== 401 && extendsSession(path)) {
    for (const listener of activityListeners) listener();
  }
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
