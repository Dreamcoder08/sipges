import { mkdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { serve } from '@hono/node-server';
import { getConnInfo } from '@hono/node-server/conninfo';
import { createApp } from './app.ts';
import { buildContainer } from './compose.ts';
import { loadConfig } from './platform/config.ts';
import { loadMigrations, migrate } from './platform/database/migrator.ts';
import { pgliteClient } from './platform/database/pglite.ts';
import { resolveClientIp } from './platform/http/client-ip.ts';
import { fileWebAssets } from './platform/http/spa.ts';
import { postgresClient } from './platform/database/postgres.ts';
import type { SqlClient } from './platform/database/sql-client.ts';

// Composition root: validate configuration first, then open adapters and build the app.
const config = loadConfig(process.env);

const openDatabase = async (): Promise<{ sql: SqlClient; close: () => Promise<void> }> => {
  if (config.databaseUrl) {
    const { client, close } = postgresClient(config.databaseUrl);
    return { sql: client, close };
  }
  await mkdir(config.pgliteDir, { recursive: true });
  const db = new PGlite(config.pgliteDir);
  console.warn(`MASCLI is using embedded PGlite at ${config.pgliteDir} (development only).`);
  return { sql: pgliteClient(db), close: () => db.close() };
};

const database = await openDatabase();
await migrate(database.sql, await loadMigrations());

const container = await buildContainer({
  config,
  sql: database.sql,
  clock: { now: () => new Date() },
  clientIp: (c) =>
    resolveClientIp({
      trustProxy: config.trustProxy,
      forwardedFor: c.req.header('x-forwarded-for'),
      socket: getConnInfo(c).remote.address,
    }),
});

const server = serve(
  {
    fetch: createApp(container, config.webDir ? { web: fileWebAssets(config.webDir) } : {}).fetch,
    hostname: config.host,
    port: config.port,
  },
  (info) => console.info(`MASCLI API listening on http://${info.address}:${info.port}`),
);

const shutdown = () => {
  server.close(() => void database.close().finally(() => process.exit(0)));
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
