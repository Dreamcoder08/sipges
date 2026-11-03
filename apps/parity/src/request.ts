import { request as httpRequest } from 'node:http';
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
  // `{origin}` stands for the base URL of the API being called (each listens on its own port).
  const headers = new Headers(
    Object.entries(c.headers ?? {}).map(([k, v]) => [k, v === '{origin}' ? baseUrl : v]),
  );
  if (c.auth && cookie) {
    const own = headers.get('cookie');
    headers.set('cookie', own ? `${own}; ${cookie}` : cookie);
  }
  if (c.sameOrigin) headers.set('origin', baseUrl);
  let body: string | null = null;
  if (c.body && 'json' in c.body) {
    headers.set('content-type', 'application/json');
    body = JSON.stringify(c.body.json);
  } else if (c.body && 'raw' in c.body) {
    if (!headers.has('content-type')) headers.set('content-type', 'application/json');
    body = c.body.raw;
  } else if (c.body) {
    headers.set('content-type', 'application/x-www-form-urlencoded');
    body = new URLSearchParams(c.body.form).toString();
  }
  const signal = AbortSignal.timeout(timeoutMs);
  if (c.rawTarget) return sendRawTarget(baseUrl, c, headers, body, timeoutMs);
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

/**
 * node:http sends the request target exactly as written; fetch would first resolve "." and
 * ".." segments and rewrite "\\", so such paths would never reach either API.
 */
const sendRawTarget = (
  baseUrl: string,
  c: ParityCase,
  headers: Headers,
  body: string | null,
  timeoutMs: number,
): Promise<Observed> =>
  new Promise((resolve, reject) => {
    const { hostname, port } = new URL(baseUrl);
    const req = httpRequest(
      {
        hostname,
        port,
        method: c.method,
        path: c.path,
        headers: Object.fromEntries(headers),
        timeout: timeoutMs,
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (text += chunk));
        res.on('end', () => {
          const contentType = res.headers['content-type'];
          let parsed: Body = { kind: 'text', value: text };
          if (contentType?.toLowerCase().includes('json')) {
            try {
              parsed = { kind: 'json', value: JSON.parse(text) };
            } catch {
              // Compared as text, so the difference shows.
            }
          }
          resolve({ status: res.statusCode ?? 0, contentType, body: parsed });
        });
      },
    );
    req.on('timeout', () =>
      req.destroy(new Error(`${c.method} ${c.path} timed out after ${timeoutMs} ms`)),
    );
    req.on('error', reject);
    req.end(body ?? undefined);
  });
