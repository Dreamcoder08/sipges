import type { GoRoute } from './go-routes.ts';

export type GoSmokeResult =
  | { readonly outcome: 'skipped' }
  | { readonly outcome: 'passed'; readonly path: string }
  | { readonly outcome: 'failed'; readonly path: string; readonly last: string };

/**
 * A listed GET route to call, preferring one with no `:name` segment. /system/auth routes are left
 * out: some answer without a session, and that 200 would roll back a healthy deploy.
 */
const probePath = (routes: readonly GoRoute[]) => {
  const reads = routes
    .filter((route) => route.method === 'GET' && !route.path.startsWith('/system/auth/'))
    .map((route) => route.path);
  const path = reads.find((candidate) => !candidate.includes(':')) ?? reads[0];
  return path?.replace(/:[^/]+/g, 'smoke');
};

/** Go refuses a request with no session before it reads anything: JSON 401 with a detail. */
const isSignInRequired = async (response: Response) => {
  if (response.status !== 401) return false;
  if (!/^application\/json\b/i.test(response.headers.get('content-type') ?? '')) return false;
  const body = (await response.json().catch(() => null)) as { detail?: unknown } | null;
  return typeof body?.detail === 'string';
};

/**
 * /health/ready always reaches TypeScript, so it cannot see a dead container. This asks a listed
 * route, with no session, for its 401; a dead container answers the Worker's 503 instead. With
 * no listed route it sends nothing. Reports statuses and error classes, never a body or a message.
 */
export const smokeGoRoute = async (options: {
  readonly routes: readonly GoRoute[];
  readonly baseUrl: string;
  readonly fetcher: typeof fetch;
  readonly sleep: (ms: number) => Promise<void>;
  readonly attempts: number;
}): Promise<GoSmokeResult> => {
  const path = probePath(options.routes);
  if (path === undefined) return { outcome: 'skipped' };
  let last = 'no attempt';
  for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
    if (attempt > 1) await options.sleep(10_000);
    try {
      const response = await options.fetcher(options.baseUrl + path, {
        headers: { accept: 'application/json' },
        redirect: 'manual',
        signal: AbortSignal.timeout(20_000),
      });
      if (await isSignInRequired(response)) return { outcome: 'passed', path };
      last = `HTTP ${response.status}`;
    } catch (error) {
      last = error instanceof Error ? error.name : typeof error;
    }
  }
  return { outcome: 'failed', path, last };
};
