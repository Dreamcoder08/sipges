import { request as httpRequest } from 'node:http';
import type { ParityCase } from './cases.ts';
import type { Body, Observed } from './diff.ts';

/** A case whose answer takes longer than this fails instead of hanging the run (and CI). */
export const REQUEST_TIMEOUT_MS = 15_000;

/** Which API a request goes to: a case's `vary` values are chosen by it. */
export type Side = 'ts' | 'go';

/** The case as one API receives it: each `{name}` of its `vary` replaced by that API's value. */
const forSide = (c: ParityCase, side: Side): ParityCase => {
  if (!c.vary) return c;
  const vary = Object.entries(c.vary);
  const fill = (text: string) =>
    vary.reduce((current, [name, values]) => current.replaceAll(`{${name}}`, values[side]), text);
  const filled: ParityCase = { ...c, path: fill(c.path) };
  const headers = c.headers
    ? { headers: Object.fromEntries(Object.entries(c.headers).map(([k, v]) => [k, fill(v)])) }
    : {};
  if (!c.body) return { ...filled, ...headers };
  const body =
    'json' in c.body
      ? { raw: fill(JSON.stringify(c.body.json)) }
      : 'raw' in c.body
        ? { raw: fill(c.body.raw) }
        : { form: Object.fromEntries(Object.entries(c.body.form).map(([k, v]) => [k, fill(v)])) };
  return { ...filled, ...headers, body };
};

/** Sends one case to one API and reads its status, media type and body. */
export const send = async (
  baseUrl: string,
  original: ParityCase,
  cookie: string | undefined,
  timeoutMs: number,
  side: Side = 'ts',
): Promise<Observed> => {
  const c = forSide(original, side);
  // `{origin}` stands for the base URL of the API being called (each listens on its own port).
  const headers = new Headers(
    Object.entries(c.headers ?? {}).map(([k, v]): [string, string] => [
      k,
      v === '{origin}' ? baseUrl : v,
    ]),
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
