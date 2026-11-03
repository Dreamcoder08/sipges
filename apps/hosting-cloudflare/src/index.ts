import { AsyncLocalStorage } from 'node:async_hooks';
import { createApp } from '../../api/src/app.ts';
import { type Container, buildContainer } from '../../api/src/compose.ts';
import { inlineDocumentReader } from '../../api/src/contexts/documents/infrastructure/index.ts';
import { portablePasswordHasher } from '../../api/src/contexts/identity/infrastructure/portable-password-hasher.ts';
import { staticReferenceReader } from '../../api/src/contexts/reference/infrastructure/static-reference-reader.ts';
import { loadConfig, parseAllowedHosts } from '../../api/src/platform/config.ts';
import { pendingMigrations } from '../../api/src/platform/database/migrator.ts';
import { postgresClient } from '../../api/src/platform/database/postgres.ts';
import { requestScopedSqlClient } from '../../api/src/platform/database/request-scoped-client.ts';
import { isSpaRequest } from '../../api/src/platform/http/spa.ts';
import { createWebApp } from '../../api/src/platform/http/web-app.ts';
// The path exactly as Hono's router and the SPA middleware see it (percent-decoded).
import { getPath } from 'hono/utils/url';
import { workerWebAssets } from './assets.ts';
import type { Env, ExecutionContext } from './bindings.ts';
import { createGoProxy } from './go-proxy.ts';
import { GO_ROUTES, forwardToGo, goRoutingEnabled, routesToGo } from './go-routes.ts';
import { MIGRATIONS } from './migrations.ts';
// Workers have no filesystem: the repository references are bundled as JSON modules.
import canonicalEntities from '../../../data/canonical_entities.json' with { type: 'json' };
import projectCoordinates from '../../../data/project_coordinates.json' with { type: 'json' };
import { r2ObjectStorage } from './r2-storage.ts';

/**
 * Cloudflare Workers entrypoint. The API stays the only source of business behaviour; this
 * module wires its ports to Hyperdrive, R2 and Static Assets. Workers forbid sharing an I/O
 * object between requests, so the container is built once per isolate around a SQL client
 * that each request binds to its own Hyperdrive connection.
 */
const sql = requestScopedSqlClient();
const deferred = new AsyncLocalStorage<Promise<unknown>[]>();

/** The database is behind the bundled migrations: the deploy step that migrates has not run. */
class PendingMigrationsError extends Error {
  readonly pending: readonly string[];
  constructor(pending: readonly string[]) {
    super(`Pending migrations: ${pending.join(', ')}. Run migrate.mjs before serving.`);
    this.name = 'PendingMigrationsError';
    this.pending = pending;
  }
}

type Backend = { readonly container: Container; readonly app: ReturnType<typeof createApp> };
/**
 * Only a finished, successful initialization is cached. A promise still in flight is bound to
 * the I/O of the request that started it: if that request is cancelled or ends first, it never
 * settles, and every request that awaited it would hang. Workers do not fail in that case.
 */
let backend: Backend | undefined;

const stringsOf = (env: Env) =>
  Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );

/** Configuration from bindings and variables only: it never opens a connection. */
const configFor = (env: Env) => {
  const vars = stringsOf(env);
  // Never derived from the request: its Host header is client-controlled.
  const allowedHosts = parseAllowedHosts(vars.SIPGES_ALLOWED_HOSTS ?? '');
  if (allowedHosts.length === 0) throw new Error('SIPGES_ALLOWED_HOSTS is required');
  return loadConfig({
    ...vars,
    NODE_ENV: 'production',
    SIPGES_DATABASE_URL: env.HYPERDRIVE.connectionString,
    SIPGES_ALLOWED_HOSTS: allowedHosts.join(','),
    // Evidence files go to R2 through the injected port; this directory is never used.
    SIPGES_UPLOAD_DIR: '/unused',
    // Cron Triggers run scheduled automation; an isolate has no long-lived timer.
    SIPGES_AUTOMATION_INTERVAL: '0',
  });
};

const initialize = async (env: Env): Promise<Backend> => {
  const vars = stringsOf(env);
  const config = configFor(env);
  // Migrations run at deploy time (migrate.mjs); a request never takes the lock or runs DDL.
  const pending = await pendingMigrations(sql.client, MIGRATIONS);
  if (pending.length > 0) {
    throw new PendingMigrationsError(pending);
  }
  const container = await buildContainer({
    config,
    sql: sql.client,
    objectStorage: r2ObjectStorage(env.EVIDENCE),
    passwordHasher: portablePasswordHasher,
    documentReader: inlineDocumentReader,
    referenceReader: staticReferenceReader({
      coordinates: projectCoordinates,
      entities: canonicalEntities,
    }),
    clock: { now: () => new Date() },
    // Set by Cloudflare's edge for every request; clients cannot override it.
    clientIp: (c) => c.req.header('cf-connecting-ip') ?? 'unknown',
  });
  const app = createApp(container, {
    web: workerWebAssets(env.ASSETS),
    eventAutomation: true,
    defer: (task) => deferred.getStore()?.push(task),
    cronSchedule: vars.SIPGES_CRON_SCHEDULE ?? '*/15 * * * *',
  });
  return { container, app };
};

let webApp: ReturnType<typeof createWebApp> | undefined;

/**
 * Built files and the HTML shell, with the same headers and host allowlist as the API but
 * without migrations check, container or Hyperdrive connection: the first load never waits
 * on the database. A configuration error is not cached, like a failed backend.
 */
const webAppFor = (env: Env) => {
  if (!webApp) {
    const config = configFor(env);
    webApp = createWebApp({
      allowedHosts: config.allowedHosts,
      hsts: config.cookieSecure,
      web: workerWebAssets(env.ASSETS),
    });
  }
  return webApp;
};

let goProxy: ReturnType<typeof createGoProxy> | undefined;

/** Go-served routes skip the TypeScript backend and its Hyperdrive connection entirely. */
const goProxyFor = (env: Env, backend: NonNullable<Env['GO_BACKEND']>) => {
  if (!goProxy) {
    const config = configFor(env);
    goProxy = createGoProxy({
      allowedHosts: config.allowedHosts,
      hsts: config.cookieSecure,
      forward: forwardToGo(backend),
    });
  }
  return goProxy;
};

const backendFor = async (env: Env): Promise<Backend> => {
  if (backend) return backend;
  // Each request that finds no backend initializes on its own connection; concurrent cold
  // starts repeat the idempotent work, which is cheaper than waiting on another request's I/O.
  // A failure is not cached: the next request retries. The first success wins the cache.
  const built = await initialize(env);
  backend ??= built;
  return backend;
};

/**
 * Runs `work` with its own Hyperdrive connection, closed only after `ended` (the response
 * body, for streams that keep querying) and every deferred task have finished.
 */
const withConnection = async <T>(
  env: Env,
  ctx: ExecutionContext,
  work: () => Promise<{ value: T; ended: Promise<unknown> }>,
): Promise<T> => {
  // Hyperdrive pools connections, so a client per request is cheap; a few in parallel cover
  // the API's concurrent transactions within one request.
  // The binding is an internal Hyperdrive socket; Hyperdrive manages TLS to the origin.
  const connection = postgresClient(env.HYPERDRIVE.connectionString, {
    max: 5,
    prepare: true,
    ssl: false,
  });
  const tasks: Promise<unknown>[] = [];
  let ended: Promise<unknown> = Promise.resolve();
  try {
    const result = await sql.run(connection.client, () => deferred.run(tasks, work));
    ended = result.ended;
    return result.value;
  } finally {
    ctx.waitUntil(
      ended
        .catch(() => undefined)
        .then(() => Promise.allSettled(tasks))
        .finally(() => connection.close()),
    );
  }
};

/** Re-wraps a streamed body so its end is observable; other responses end immediately. */
const observeEnd = (response: Response) => {
  if (!response.body) return { value: response, ended: Promise.resolve() };
  const { readable, writable } = new TransformStream();
  const ended = response.body.pipeTo(writable);
  return { value: new Response(readable, response), ended };
};

const unavailable = (error: unknown) => {
  // Only the error class and pending versions are logged: other messages may contain
  // connection strings or data.
  console.error('SIPGES initialization failed', {
    kind: error instanceof Error ? error.name : typeof error,
    ...(error instanceof PendingMigrationsError ? { pending: error.pending } : {}),
  });
  return new Response(JSON.stringify({ detail: 'SIPGES no está disponible temporalmente' }), {
    status: 503,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
};

export default {
  fetch: async (request: Request, env: Env, ctx: ExecutionContext): Promise<Response> => {
    if (isSpaRequest(request.method, getPath(request), request.headers.get('accept'))) {
      let web: ReturnType<typeof webAppFor>;
      try {
        web = webAppFor(env);
      } catch (error) {
        return unavailable(error);
      }
      return web.fetch(request);
    }
    if (
      env.GO_BACKEND &&
      goRoutingEnabled(env) &&
      routesToGo(GO_ROUTES, request.method, getPath(request))
    ) {
      let proxy: ReturnType<typeof goProxyFor>;
      try {
        proxy = goProxyFor(env, env.GO_BACKEND);
      } catch (error) {
        return unavailable(error);
      }
      return proxy.fetch(request);
    }
    return withConnection(env, ctx, async () => {
      let app: Backend['app'];
      try {
        ({ app } = await backendFor(env));
      } catch (error) {
        return { value: unavailable(error), ended: Promise.resolve() };
      }
      return observeEnd(await app.fetch(request));
    });
  },

  scheduled: (_event: unknown, env: Env, ctx: ExecutionContext): Promise<void> =>
    withConnection(env, ctx, async () => {
      const { container } = await backendFor(env);
      await container.runtime.scheduled();
      return { value: undefined, ended: Promise.resolve() };
    }),
};

// The Durable Object class the `go` environment binds as GO_BACKEND; unused in production.
export { GoBackend } from './go-container.ts';
