import { Hono } from 'hono';
import { fileURLToPath } from 'node:url';
import { securityHeaders } from '../../api/src/platform/http/security-headers.ts';
import { bodyLimit } from 'hono/body-limit';
import { privateBlobStorage } from './blob-storage.ts';
import { createApp } from '../../api/src/app.ts';
import { buildContainer } from '../../api/src/compose.ts';
import { hostAllowlist } from '../../api/src/platform/http/host.ts';
import { loadConfig, parseAllowedHosts } from '../../api/src/platform/config.ts';
import { openDatabase } from '../../api/src/platform/database/open.ts';
import { loadMigrations, migrate } from '../../api/src/platform/database/migrator.ts';
import { spaMiddleware, fileWebAssets } from '../../api/src/platform/http/spa.ts';
import { createHostedApp } from './lazy-app.ts';

/** Vercel entrypoint; the normal API remains the only source of business behavior. */
const allowedHosts = parseAllowedHosts(
  process.env.MASCLI_ALLOWED_HOSTS ??
    [process.env.VERCEL_PROJECT_PRODUCTION_URL, process.env.VERCEL_URL].filter(Boolean).join(','),
);
const web = fileWebAssets(fileURLToPath(new URL('../public/', import.meta.url)));
const app = new Hono()
  .use('*', securityHeaders({ hsts: true }))
  .use('*', hostAllowlist(allowedHosts))
  .use('*', spaMiddleware(web))
  .use(
    '*',
    bodyLimit({
      maxSize: 4 * 1024 * 1024,
      onError: (c) =>
        c.json({ detail: 'El envío supera el máximo de 4 MiB, incluidos todos los archivos' }, 413),
    }),
  )
  .route(
    '/',
    createHostedApp(async () => {
      if (!process.env.BLOB_READ_WRITE_TOKEN && !process.env.BLOB_STORE_ID) {
        throw new Error('Private Blob storage is required for the demo');
      }
      if (allowedHosts.length === 0) throw new Error('An explicit demo host is required');
      const config = loadConfig({
        ...process.env,
        NODE_ENV: 'production',
        MASCLI_DATABASE_URL:
          process.env.MASCLI_DATABASE_URL ?? process.env.DATABASE_URL ?? process.env.POSTGRES_URL,
        MASCLI_ALLOWED_HOSTS: allowedHosts.join(','),
        MASCLI_WEB_DIR: `${process.cwd()}/public`,
        MASCLI_UPLOAD_DIR: '/tmp/mascli-demo-uploads',
        MASCLI_MAX_UPLOAD_BYTES: '3145728',
      });
      const database = await openDatabase(config);
      try {
        await migrate(database.sql, await loadMigrations());
        const container = await buildContainer({
          config,
          sql: database.sql,
          objectStorage: privateBlobStorage(),
          clock: { now: () => new Date() },
          // This adapter is exclusively for Vercel, which sets the trusted proxy header.
          clientIp: (c) => c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown',
        });
        return createApp(container);
      } catch (error) {
        await database.close();
        throw error;
      }
    }),
  );

export default app;
