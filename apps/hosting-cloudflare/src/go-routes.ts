/**
 * Strangler routing (docs/adr/0032 §4, §6): the routes the Worker sends to the Go container
 * instead of the TypeScript backend. The list is data; a route joins it only after its parity
 * cases pass (apps/parity) and an owner-visible measurement, and leaves it to switch back.
 * Routing is off unless SIPGES_GO_ROUTING is '1' and the GO_BACKEND binding exists. Production
 * has the binding but not the switch, so it keeps every route on TypeScript.
 */
import type { GoBackendNamespace } from './bindings.ts';

export type GoRoute = {
  readonly method: 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Exact path; a `:name` segment matches one non-empty segment. No query string. */
  readonly path: string;
};

export const GO_ROUTES: readonly GoRoute[] = [];

/**
 * Idle time before the container stops. Cold start measured at 0.74–0.88 s after sleep (ADR
 * 0032 §4), and each new database connection costs 170–230 ms, so a stop is felt. Only Go-routed
 * requests keep the container awake: ten minutes covers the pauses between screens of one work
 * session and bounds billed idle time to ten minutes after the last of them. (Once /system/events,
 * polled every 10 s by an open screen, moves to Go, any open screen keeps it warm.)
 */
export const GO_SLEEP_AFTER = '10m';

/**
 * One named instance holds the warm connection pool; the hint keeps its Durable Object (and so
 * the container) in eastern North America, next to Neon us-east-1, not at the caller's edge.
 */
export const GO_INSTANCE = { name: 'go-enam', locationHint: 'enam' } as const;

const matches = (pattern: string, path: string) => {
  const want = pattern.split('/');
  const got = path.split('/');
  return (
    want.length === got.length &&
    want.every((part, i) => (part.startsWith(':') ? (got[i] ?? '') !== '' : part === got[i]))
  );
};

/** Whether `method path` (the decoded path, as Hono sees it) is on the list. */
export const routesToGo = (routes: readonly GoRoute[], method: string, path: string) =>
  routes.some((route) => route.method === method && matches(route.path, path));

/** Routing needs both the explicit switch and the container binding. */
export const goRoutingEnabled = (env: Readonly<Record<string, unknown>>) =>
  env.SIPGES_GO_ROUTING === '1' && env.GO_BACKEND !== undefined;

/** Problems in a route list; every route needs a parity case for the same method and path. */
export const validateGoRoutes = (
  routes: readonly GoRoute[],
  parityCases: readonly { readonly method: string; readonly path: string }[],
) => {
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const route of routes) {
    const key = `${route.method} ${route.path}`;
    if (seen.has(key)) {
      errors.push(`${key}: duplicate route`);
      continue;
    }
    seen.add(key);
    if (!/^\/(api|system)\//.test(route.path)) {
      errors.push(`${key}: only /api/ and /system/ routes move to Go`);
    }
    const covered = parityCases.some(
      (c) => c.method === route.method && matches(route.path, c.path.split('?')[0] ?? ''),
    );
    if (!covered) errors.push(`${key}: no parity case in apps/parity/src/cases.ts`);
  }
  return errors;
};

/**
 * What the container receives when the Worker has it. Every name is optional and none gets a
 * default here: an unset SIPGES_REQUIRE_MFA or SIPGES_COOKIE_SECURE stays unset, and Go then keeps
 * it on. Left out on purpose: SIPGES_GO_AUTOMATION_CRON and SIPGES_AUTOMATION_INTERVAL (the cron
 * stays with TypeScript, go-automation-cron.md), SIPGES_OCR* (no OCR in the image),
 * SIPGES_TRUST_PROXY and SIPGES_UPLOAD_DIR (other hosting) and SIPGES_ALLOW_PRIVILEGED_DB_ROLE
 * (synthetic test servers only). Values are secrets: never log them.
 */
const GO_FORWARDED_ENV = [
  // The identity bootstrap: without a password an empty installation stops the container.
  'SIPGES_ADMIN_USERNAME',
  'SIPGES_ADMIN_PASSWORD',
  'SIPGES_ADMIN_FULL_NAME',
  // What GET /system/automations/runtime reports. Go ignores the secret on the cron route until
  // SIPGES_GO_AUTOMATION_CRON is on.
  'SIPGES_CRON_SECRET',
  'CRON_SECRET',
  'SIPGES_CRON_SCHEDULE',
  // Sessions and the request log.
  'SIPGES_REQUIRE_MFA',
  'SIPGES_COOKIE_SECURE',
  'SIPGES_ACCESS_LOG',
  // TOTP, identity and automation channel secrets.
  'SIPGES_DATA_KEY',
  'SIPGES_DATA_KEY_PREVIOUS',
  // Evidence files. The R2 binding stays in the Worker, so the container uses R2's S3 API
  // (go-trial-runbook.md, "Evidence files from the container").
  'SIPGES_STORAGE',
  'SIPGES_S3_ENDPOINT',
  'SIPGES_S3_REGION',
  'SIPGES_S3_BUCKET',
  'SIPGES_S3_ACCESS_KEY_ID',
  'SIPGES_S3_SECRET_ACCESS_KEY',
  'SIPGES_MAX_UPLOAD_BYTES',
  // Google sign-in.
  'SIPGES_GOOGLE_CLIENT_ID',
  'SIPGES_GOOGLE_CLIENT_SECRET',
  'SIPGES_GOOGLE_ADMIN_EMAIL',
  // Push.
  'SIPGES_VAPID_PUBLIC_KEY',
  'SIPGES_VAPID_PRIVATE_KEY',
  'SIPGES_VAPID_SUBJECT',
  // Semantic analysis.
  'SIPGES_OLLAMA_URL',
  'SIPGES_OLLAMA_EMBED_MODEL',
  'SIPGES_SEMANTIC_SEARCH',
  // Analyst prose.
  'SIPGES_ANALYST_PROVIDER',
  'SIPGES_ANALYST_MODEL',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
] as const;

/**
 * The container's environment: only what apps/api-go reads. The database URL is a secret of
 * the `go` environment (Hyperdrive is not reachable from containers, ADR 0032 §4): the
 * container connects to Neon over TLS itself.
 */
export const goContainerEnv = (env: Readonly<Record<string, unknown>>) => {
  const vars: Record<string, string> = {
    SIPGES_HOST: '0.0.0.0',
    SIPGES_PORT: '8080',
    // Only this Worker reaches the container, and Cloudflare's edge sets the header.
    SIPGES_TRUST_CF_CONNECTING_IP: '1',
  };
  if (typeof env.SIPGES_ALLOWED_HOSTS === 'string') {
    vars.SIPGES_ALLOWED_HOSTS = env.SIPGES_ALLOWED_HOSTS;
  }
  if (typeof env.SIPGES_GO_DATABASE_URL === 'string') {
    vars.SIPGES_DATABASE_URL = env.SIPGES_GO_DATABASE_URL;
  }
  for (const name of GO_FORWARDED_ENV) {
    const value = env[name];
    if (typeof value === 'string') vars[name] = value;
  }
  return vars;
};

/** Forwards a request to the named Go instance. */
export const forwardToGo = (backend: GoBackendNamespace) => (request: Request) =>
  backend
    .get(backend.idFromName(GO_INSTANCE.name), { locationHint: GO_INSTANCE.locationHint })
    .fetch(request);
