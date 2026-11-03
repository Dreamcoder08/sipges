/**
 * The parity route list (docs/adr/0032 §6): every route the Go API serves gets at least one case
 * here, and a route switches to Go only while its cases pass. Later phases add entries; the
 * runner does not change.
 */

export type Method = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export type ParityCase = {
  /** Unique, stable name shown in the report. */
  readonly name: string;
  readonly method: Method;
  /** Path and query, starting with `/`. */
  readonly path: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: { readonly json: unknown } | { readonly form: Readonly<Record<string, string>> };
  /**
   * `admin` sends the session of the synthetic administrator the runner seeds and signs in
   * through the TypeScript API; both APIs read sessions from the same database.
   */
  readonly auth?: 'admin';
  /** Sends `Origin` set to each API's own base URL, as a same-origin browser write would. */
  readonly sameOrigin?: true;
  /**
   * JSON paths whose value legitimately differs between two runs (ids, timestamps), such as
   * `id` or `items.*.created_at`. Keep the list small: name fields, never whole objects.
   */
  readonly normalize?: readonly string[];
};

export const CASES: readonly ParityCase[] = [
  { name: 'liveness', method: 'GET', path: '/health' },
  { name: 'liveness ignores the query string', method: 'GET', path: '/health?probe=1' },
  { name: 'readiness with the database up', method: 'GET', path: '/health/ready' },
  { name: 'unknown path with a session', method: 'GET', path: '/no-such-route', auth: 'admin' },
  { name: 'trailing slash is another path', method: 'GET', path: '/health/', auth: 'admin' },

  // Session, Origin, project scope and role gates (identity and tenancy middleware, T8).
  { name: 'unknown path without a session', method: 'GET', path: '/no-such-route' },
  { name: 'current scope without a session', method: 'GET', path: '/system/auth/current-scope' },
  {
    name: 'current scope with an unknown session',
    method: 'GET',
    path: '/system/auth/current-scope',
    headers: { cookie: `sipges_session=${'0'.repeat(64)}` },
  },
  {
    name: 'current scope with a session',
    method: 'GET',
    path: '/system/auth/current-scope',
    auth: 'admin',
  },
  {
    name: 'current scope of a project without a grant',
    method: 'GET',
    path: '/system/auth/current-scope',
    auth: 'admin',
    headers: { 'x-sipges-scope': 'ACME/NORTE' },
  },
  {
    name: 'query project_id outside the scope',
    method: 'GET',
    path: '/system/auth/current-scope?project_id=NORTE',
    auth: 'admin',
  },
  { name: 'write without Origin', method: 'POST', path: '/no-such-route', auth: 'admin' },
  {
    name: 'same-origin write reaches routing',
    method: 'POST',
    path: '/no-such-route',
    auth: 'admin',
    sameOrigin: true,
  },
  {
    name: 'JSON body naming another project',
    method: 'POST',
    path: '/api/eventos',
    auth: 'admin',
    sameOrigin: true,
    body: { json: { project_id: 'NORTE', payload: {} } },
  },
  // Reference context (T15): repository references of the registered tenant only. Every role
  // may read them, so the 403s come from the project scope, never from the role gate.
  ...['/system/project-coordinates', '/system/canonical-entities'].flatMap((path): ParityCase[] => [
    { name: `${path} without a session`, method: 'GET', path },
    {
      name: `${path} with an unknown session`,
      method: 'GET',
      path,
      headers: { cookie: `sipges_session=${'0'.repeat(64)}` },
    },
    { name: `${path} with a session`, method: 'GET', path, auth: 'admin' },
    {
      name: `${path} with project_id of the scope`,
      method: 'GET',
      path: `${path}?project_id=PRJ-SECHURA`,
      auth: 'admin',
    },
    {
      name: `${path} of a project without a grant`,
      method: 'GET',
      path,
      auth: 'admin',
      headers: { 'x-sipges-scope': 'ACME/NORTE' },
    },
    {
      name: `${path} with project_id outside the scope`,
      method: 'GET',
      path: `${path}?project_id=NORTE`,
      auth: 'admin',
    },
    { name: `${path} rejects a write`, method: 'POST', path, auth: 'admin', sameOrigin: true },
  ]),
];

/** Problems in a route list; empty when it is valid. */
export const validateCases = (cases: readonly ParityCase[]): string[] => {
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const c of cases) {
    if (seen.has(c.name)) errors.push(`${c.name}: duplicate case name`);
    seen.add(c.name);
    if (!c.path.startsWith('/')) errors.push(`${c.name}: path must start with /`);
    for (const path of c.normalize ?? []) {
      if (path.split('.').every((part) => part === '*' || part === '')) {
        errors.push(`${c.name}: normalize path "${path}" is too broad (name a field)`);
      }
    }
  }
  return errors;
};
