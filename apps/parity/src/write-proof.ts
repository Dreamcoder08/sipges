/**
 * Proves what comparing the two APIs cannot: parity passes when both answer the same, so two equal
 * 500s pass, and so does a 200 that wrote nothing because forced row-level security hid the row.
 * For each write route, one case must answer 2xx on both APIs and leave rows from both.
 */
import type { ParityCase } from './types.ts';
import { type WriteRoute, WRITE_ROUTES } from './write-routes.ts';

export type LedgerRow = { readonly api: 'ts' | 'go'; readonly table: string };

/** Written by nearly every request, so they prove nothing about the route itself. */
const INCIDENTAL = new Set(['audit', 'login_failures', 'sessions']);

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const toRegExp = (path: string) =>
  new RegExp(`^${path.replace(/:[a-z]+/gi, '[^/]+').replace(/\//g, '\\/')}$`);

const MATCHERS = new Map(WRITE_ROUTES.map((route) => [route, toRegExp(route.path)]));

/** The route a case calls. A literal segment wins over a parameter, as in the routers. */
export const routeOf = (
  c: Pick<ParityCase, 'method' | 'path'>,
  routes: readonly WriteRoute[] = WRITE_ROUTES,
): WriteRoute | undefined => {
  const path = c.path.split('?')[0] ?? '';
  const matching = routes.filter(
    (route) =>
      route.method === c.method && (MATCHERS.get(route) ?? toRegExp(route.path)).test(path),
  );
  return matching.sort((a, b) => a.path.split(':').length - b.path.split(':').length)[0];
};

const landed = (route: WriteRoute, rows: readonly LedgerRow[], api: LedgerRow['api']) => {
  const own = rows.filter((row) => row.api === api).map((row) => row.table);
  if (route.rows === 'none') return true;
  if (route.rows === 'domain') return own.some((table) => !INCIDENTAL.has(table));
  return route.rows.some((table) => own.includes(table));
};

const normal = (route: WriteRoute, status: number) =>
  route.normal === undefined ? status >= 200 && status < 300 : status === route.normal;

export const isWriteCase = (c: Pick<ParityCase, 'method'>) => WRITE_METHODS.has(c.method);

export type Attempt = {
  readonly name: string;
  readonly ts: number;
  readonly go: number;
  readonly proved: boolean;
};

export class WriteProof {
  readonly #attempts = new Map<WriteRoute, Attempt[]>();
  readonly #routes: readonly WriteRoute[];

  constructor(routes: readonly WriteRoute[] = WRITE_ROUTES) {
    this.#routes = routes;
  }

  record(c: ParityCase, ts: number, go: number, rows: readonly LedgerRow[]) {
    const route = routeOf(c, this.#routes);
    if (!route) return;
    const proved =
      normal(route, ts) &&
      normal(route, go) &&
      landed(route, rows, 'ts') &&
      landed(route, rows, 'go');
    const attempts = this.#attempts.get(route) ?? [];
    attempts.push({ name: c.name, ts, go, proved });
    this.#attempts.set(route, attempts);
  }

  /** Every route no case proved, with what its cases did get, for the report. */
  unproved() {
    return this.#routes
      .filter((route) => {
        const attempts = this.#attempts.get(route) ?? [];
        return route.blocked ? attempts.length === 0 : !attempts.some((a) => a.proved);
      })
      .map((route) => ({ route, attempts: this.#attempts.get(route) ?? [] }));
  }

  /** Routes a run can reach but not complete, each with its reason. */
  blocked() {
    return this.#routes.filter((route) => route.blocked);
  }
}
