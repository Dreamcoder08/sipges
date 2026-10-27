import { AsyncLocalStorage } from 'node:async_hooks';
import { createApp } from '../../api/src/app.ts';
import { type Container, buildContainer } from '../../api/src/compose.ts';
import { inlineDocumentReader } from '../../api/src/contexts/documents/infrastructure/index.ts';
import { wasmPasswordHasher } from '../../api/src/contexts/identity/infrastructure/wasm-password-hasher.ts';
import { loadConfig, parseAllowedHosts } from '../../api/src/platform/config.ts';
import { migrate } from '../../api/src/platform/database/migrator.ts';
import { postgresClient } from '../../api/src/platform/database/postgres.ts';
import { requestScopedSqlClient } from '../../api/src/platform/database/request-scoped-client.ts';
import { workerWebAssets } from './assets.ts';
import type { Env, ExecutionContext } from './bindings.ts';
import { MIGRATIONS } from './migrations.ts';
import { r2ObjectStorage } from './r2-storage.ts';

/**
 * Cloudflare Workers entrypoint. The API stays the only source of business behaviour; this
 * module wires its ports to Hyperdrive, R2 and Static Assets. Workers forbid sharing an I/O
 * object between requests, so the container is built once per isolate around a SQL client
 * that each request binds to its own Hyperdrive connection.
 */
const sql = requestScopedSqlClient();
const deferred = new AsyncLocalStorage<Promise<unknown>[]>();

type Backend = { readonly container: Container; readonly app: ReturnType<typeof createApp> };
let backend: Promise<Backend> | undefined;

const stringsOf = (env: Env) =>
  Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );

const initialize = async (env: Env): Promise<Backend> => {
  const vars = stringsOf(env);
  // Never derived from the request: its Host header is client-controlled.
  const allowedHosts = parseAllowedHosts(vars.MASCLI_ALLOWED_HOSTS ?? '');
  if (allowedHosts.length === 0) throw new Error('MASCLI_ALLOWED_HOSTS is required');
  const config = loadConfig({
    ...vars,
    NODE_ENV: 'production',
    MASCLI_DATABASE_URL: env.HYPERDRIVE.connectionString,
    MASCLI_ALLOWED_HOSTS: allowedHosts.join(','),
    // Evidence files go to R2 through the injected port; this directory is never used.
    MASCLI_UPLOAD_DIR: '/unused',
    // Cron Triggers run scheduled automation; an isolate has no long-lived timer.
    MASCLI_AUTOMATION_INTERVAL: '0',
  });
  await migrate(sql.client, MIGRATIONS);
  const container = await buildContainer({
    config,
    sql: sql.client,
    objectStorage: r2ObjectStorage(env.EVIDENCE),
    passwordHasher: wasmPasswordHasher,
    documentReader: inlineDocumentReader,
    clock: { now: () => new Date() },
    // Set by Cloudflare's edge for every request; clients cannot override it.
    clientIp: (c) => c.req.header('cf-connecting-ip') ?? 'unknown',
  });
  const app = createApp(container, {
    web: workerWebAssets(env.ASSETS),
    eventAutomation: true,
    defer: (task) => deferred.getStore()?.push(task),
    cronSchedule: vars.MASCLI_CRON_SCHEDULE ?? '*/15 * * * *',
  });
  return { container, app };
};

const backendFor = (env: Env) => {
  // One initialization per isolate; a failed attempt is retried by the next request.
  backend ??= initialize(env).catch((error: unknown) => {
    backend = undefined;
    throw error;
  });
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
  const connection = postgresClient(env.HYPERDRIVE.connectionString, { max: 5, prepare: true });
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
  // Only the error class is logged: messages may contain connection strings or data.
  console.error('MASCLI initialization failed', {
    kind: error instanceof Error ? error.name : typeof error,
  });
  return new Response(JSON.stringify({ detail: 'MASCLI no está disponible temporalmente' }), {
    status: 503,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
};

export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext): Promise<Response> =>
    withConnection(env, ctx, async () => {
      let app: Backend['app'];
      try {
        ({ app } = await backendFor(env));
      } catch (error) {
        return { value: unavailable(error), ended: Promise.resolve() };
      }
      return observeEnd(await app.fetch(request));
    }),

  scheduled: (_event: unknown, env: Env, ctx: ExecutionContext): Promise<void> =>
    withConnection(env, ctx, async () => {
      const { container } = await backendFor(env);
      await container.runtime.scheduled();
      return { value: undefined, ended: Promise.resolve() };
    }),
};
