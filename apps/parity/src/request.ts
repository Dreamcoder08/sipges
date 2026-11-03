import type { ParityCase } from './cases.ts';
import type { Body, Observed } from './diff.ts';

/** A case whose answer takes longer than this fails instead of hanging the run (and CI). */
export const REQUEST_TIMEOUT_MS = 15_000;

/** Sends one case to one API and reads its status, media type and body. */
export const send = async (
  baseUrl: string,
  c: ParityCase,
  cookie: string | undefined,
  timeoutMs: number,
): Promise<Observed> => {
  const headers = new Headers(c.headers);
  if (c.auth && cookie) headers.set('cookie', cookie);
  let body: string | null = null;
  if (c.body && 'json' in c.body) {
    headers.set('content-type', 'application/json');
    body = JSON.stringify(c.body.json);
  } else if (c.body) {
    headers.set('content-type', 'application/x-www-form-urlencoded');
    body = new URLSearchParams(c.body.form).toString();
  }
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const response = await fetch(`${baseUrl}${c.path}`, {
      method: c.method,
      headers,
      body,
      redirect: 'manual',
      signal,
    });
    const contentType = response.headers.get('content-type') ?? undefined;
    const text = await response.text();
    let parsed: Body = { kind: 'text', value: text };
    if (contentType?.toLowerCase().includes('json')) {
      try {
        parsed = { kind: 'json', value: JSON.parse(text) };
      } catch {
        // A JSON media type with an invalid body compares as text, so the difference shows.
      }
    }
    return { status: response.status, contentType, body: parsed };
  } catch (error) {
    if (signal.aborted)
      throw new Error(`${c.method} ${c.path} timed out after ${timeoutMs} ms`, { cause: error });
    throw error;
  }
};
