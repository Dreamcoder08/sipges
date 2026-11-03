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
  /** Extra headers; the value `{origin}` becomes the base URL of the API being called. */
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: { readonly json: unknown } | { readonly form: Readonly<Record<string, string>> };
  /**
   * Sends the session of a synthetic user the runner seeds through the TypeScript API (seed.ts):
   * `admin` holds two projects and must choose one; `consulta` holds one, chosen automatically.
   * Both APIs read sessions from the same database.
   */
  readonly auth?: 'admin' | 'consulta';
  /**
   * JSON paths whose value legitimately differs between two runs (ids, timestamps), such as
   * `id` or `items.*.created_at`. Keep the list small: name fields, never whole objects.
   */
  readonly normalize?: readonly string[];
};

const UNKNOWN_TOKEN = 'sipges_session=' + 'f'.repeat(64);
const WITH_ORIGIN = { origin: '{origin}' };
const SECOND = { 'x-sipges-scope': 'PARITY/PRJ-B' };

export const CASES: readonly ParityCase[] = [
  { name: 'liveness', method: 'GET', path: '/health' },
  { name: 'liveness ignores the query string', method: 'GET', path: '/health?probe=1' },
  { name: 'readiness with the database up', method: 'GET', path: '/health/ready' },

  // GET /system/auth/me and /system/auth/providers: public, served by Go.
  { name: 'me without a session is null', method: 'GET', path: '/system/auth/me' },
  {
    name: 'me with an unknown session is null',
    method: 'GET',
    path: '/system/auth/me',
    headers: { cookie: UNKNOWN_TOKEN },
  },
  { name: 'me with a session', method: 'GET', path: '/system/auth/me', auth: 'consulta' },
  { name: 'sign-in providers', method: 'GET', path: '/system/auth/providers' },

  // The request pipeline every authenticated route runs (session, Origin, project, role), seen
  // through paths neither API serves, so only the pipeline answers.
  { name: 'no session', method: 'GET', path: '/no-such-route' },
  {
    name: 'unknown session',
    method: 'GET',
    path: '/no-such-route',
    headers: { cookie: UNKNOWN_TOKEN },
  },
  {
    name: 'one project is chosen automatically',
    method: 'GET',
    path: '/no-such-route',
    auth: 'consulta',
  },
  { name: 'trailing slash is another path', method: 'GET', path: '/health/', auth: 'consulta' },
  { name: 'two projects need a choice', method: 'GET', path: '/no-such-route', auth: 'admin' },
  {
    name: 'X-SIPGES-Scope chooses',
    method: 'GET',
    path: '/no-such-route',
    auth: 'admin',
    headers: SECOND,
  },
  {
    name: 'the scope cookie chooses',
    method: 'GET',
    path: '/no-such-route',
    auth: 'admin',
    headers: { cookie: 'sipges_scope=PARITY%2FPRJ-B' },
  },
  {
    name: 'an ungranted scope is refused',
    method: 'GET',
    path: '/no-such-route',
    auth: 'consulta',
    headers: SECOND,
  },
  {
    name: 'project_id of another project',
    method: 'GET',
    path: '/system/no-such-route?project_id=PRJ-B',
    auth: 'consulta',
  },
  {
    name: 'undecodable project_id',
    method: 'GET',
    path: '/system/no-such-route?project_id=%ZZ',
    auth: 'consulta',
  },
  { name: 'write without Origin', method: 'POST', path: '/system/no-such-route', auth: 'admin' },
  {
    name: 'write without a session checks the session first',
    method: 'POST',
    path: '/system/no-such-route',
    headers: WITH_ORIGIN,
  },
  {
    name: 'read-only role cannot write',
    method: 'POST',
    path: '/system/no-such-route',
    auth: 'consulta',
    headers: WITH_ORIGIN,
  },
  { name: 'admin-only area', method: 'GET', path: '/system/audit/no-such-route', auth: 'consulta' },
  {
    name: 'JSON body naming another project',
    method: 'POST',
    path: '/system/no-such-route',
    auth: 'admin',
    headers: { ...WITH_ORIGIN, ...SECOND },
    body: { json: { project_id: 'PRJ-SECHURA' } },
  },
  {
    name: 'JSON body of the chosen project',
    method: 'POST',
    path: '/system/no-such-route',
    auth: 'admin',
    headers: { ...WITH_ORIGIN, ...SECOND },
    body: { json: { payload: { Proyecto_ID: 'PRJ-B' } } },
  },
  {
    name: 'public write without Origin',
    method: 'POST',
    path: '/system/auth/me',
    auth: 'consulta',
  },
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
