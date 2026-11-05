/** The shape of one parity case; cases.ts and contexts/*.ts declare them. */

export type Method = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export type ParityCase = {
  /** Unique, stable name shown in the report. */
  readonly name: string;
  readonly method: Method;
  /** Path and query, starting with `/`. */
  readonly path: string;
  /** Extra headers; the value `{origin}` becomes the base URL of the API being called. */
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?:
    | { readonly json: unknown }
    | { readonly form: Readonly<Record<string, string>> }
    /** Sent byte for byte (application/json unless headers say otherwise). */
    | { readonly raw: string };
  /** Send `path` exactly as written (dot segments, backslashes), through node:http. */
  readonly rawTarget?: boolean;
  /**
   * Sends the session of a synthetic user the runner seeds through the TypeScript API (seed.ts):
   * `admin` holds the default project; `consulta` (read-only role) holds it too; `multi`
   * (analista) holds two projects and must choose one. Both APIs read the same sessions.
   */
  readonly auth?: 'admin' | 'consulta' | 'multi';
  /** Sends `Origin` set to each API's own base URL, as a same-origin browser write would. */
  readonly sameOrigin?: true;
  /**
   * JSON paths whose value legitimately differs between two runs (ids, timestamps), such as
   * `id` or `items.*.created_at`. Keep the list small: name fields, never whole objects.
   */
  readonly normalize?: readonly string[];
  /**
   * Values that differ per API, written `{name}` in `path`, header values and the body. Both
   * APIs receive every case at once, on one database, so a write that succeeds once (creating
   * or deleting a row) names a row of its own on each side, such as `{ w: { ts: 'WT', go: 'WG' } }`.
   */
  readonly vary?: Readonly<Record<string, { readonly ts: string; readonly go: string }>>;
};
