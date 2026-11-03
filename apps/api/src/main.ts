import { serve } from '@hono/node-server';
import { getConnInfo } from '@hono/node-server/conninfo';
import { createApp } from './app.ts';
import { buildContainer } from './compose.ts';
import { loadConfig } from './platform/config.ts';
import { loadMigrations, migrate } from './platform/database/migrator.ts';
import { openDatabase } from './platform/database/open.ts';
import { resolveClientIp } from './platform/http/client-ip.ts';
import { fileWebAssets } from './platform/http/spa.ts';
import { log } from './platform/observability/logger.ts';
import { skipWhileRunning } from './platform/skip-while-running.ts';

// Composition root: validate configuration first, then open adapters and build the app.
const config = loadConfig(process.env);

const database = await openDatabase(config);
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
    fetch: createApp(container, {
      eventAutomation: true,
      ...(config.webDir ? { web: fileWebAssets(config.webDir) } : {}),
    }).fetch,
    hostname: config.host,
    port: config.port,
  },
  (info) => console.info(`SIPGES API listening on http://${info.address}:${info.port}`),
);

// Automations tick in-process on a long-running server (ADR 0014 §4). A tick slower than the
// interval makes the next one skip instead of overlapping and holding more pool connections.
const automationTick = skipWhileRunning(() => container.runtime.scheduled(), {
  onError: (error) => log('error', 'automation_tick_failed', { error }),
  onSkip: (runningForMs) =>
    log('warn', 'automation_tick_skipped', {
      reason: 'previous tick still running',
      running_for_ms: runningForMs,
      interval_seconds: config.automation.intervalSeconds,
    }),
});
const automationTimer =
  config.automation.intervalSeconds > 0
    ? setInterval(automationTick, config.automation.intervalSeconds * 1000)
    : undefined;
automationTimer?.unref();

const shutdown = () => {
  if (automationTimer) clearInterval(automationTimer);
  server.close(() => void database.close().finally(() => process.exit(0)));
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
