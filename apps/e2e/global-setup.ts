import { randomBytes } from 'node:crypto';
import path from 'node:path';
import postgres from 'postgres';
import { usingCleanup } from './support/cleanup.ts';
import {
  GO_DATABASE_PREFIX,
  e2eRuntime,
  goApiEnv,
  goMigrateEnv,
  scratchDatabaseUrl,
} from './support/runtime.ts';
import {
  assertWebBuilt,
  assertWorkerBuilt,
  buildGoApi,
  migrateGoApi,
  migrationsDir,
  type RunningApi,
  scratchDir,
  startApi,
  startGoApi,
  startWorker,
  syntheticSecrets,
  webDist,
} from './support/server.ts';

export const ADMIN_USERNAME = 'e2e-admin';

/**
 * Boots one isolated SIPGES instance for the suite: the real API (apps/api/src/main.ts) serving
 * the built SPA, a fresh synthetic database and generated credentials. The database is PGlite in
 * a temporary directory, or a throwaway database on the PostgreSQL server named by
 * SIPGES_E2E_DATABASE_URL (created here, dropped in the returned teardown).
 * SIPGES_E2E_RUNTIME=workers or =go swaps the Node API for the Cloudflare Worker or the Go API
 * (apps/api-go), both on that throwaway database.
 * Credentials reach the tests only through this process's environment, never through files.
 */
export default async function globalSetup() {
  const runtime = e2eRuntime(process.env.SIPGES_E2E_RUNTIME);
  return usingCleanup(async (register) => {
    assertWebBuilt();
    const scratch = await scratchDir('suite');
    const secrets = syntheticSecrets();
    register(scratch.remove);

    let database: Record<string, string> = { SIPGES_PGLITE_DIR: path.join(scratch.dir, 'pglite') };
    const serverUrl = process.env.SIPGES_E2E_DATABASE_URL;
    if (runtime !== 'node' && !serverUrl) {
      throw new Error(
        `SIPGES_E2E_RUNTIME=${runtime} needs SIPGES_E2E_DATABASE_URL (no PGlite there)`,
      );
    }
    // Go builds before any database exists, so a compile error leaves nothing behind.
    const goBinary = runtime === 'go' ? await buildGoApi(scratch.dir) : undefined;
    if (serverUrl) {
      const prefix = runtime === 'go' ? GO_DATABASE_PREFIX : 'sipges_e2e_';
      const name = `${prefix}${randomBytes(6).toString('hex')}`;
      const admin = postgres(serverUrl, { max: 1, onnotice: () => undefined });
      register(() => admin.end());
      await admin.unsafe(`CREATE DATABASE ${name}`);
      register(async () => {
        await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      });
      database = { SIPGES_DATABASE_URL: scratchDatabaseUrl(serverUrl, name) };
    }

    const shared = {
      // This suite isolates parity/cookie behavior; mandatory MFA has its own browser test.
      SIPGES_REQUIRE_MFA: '0',
      // Explicit opt-in for synthetic browser suites running on intentional local HTTP.
      // The default suite still tests Secure cookies and leaves this unset.
      SIPGES_COOKIE_SECURE: process.env.SIPGES_E2E_COOKIE_SECURE,
      SIPGES_DATA_KEY: secrets.dataKey,
      SIPGES_ADMIN_USERNAME: ADMIN_USERNAME,
      SIPGES_ADMIN_PASSWORD: secrets.adminPassword,
      SIPGES_ADMIN_FULL_NAME: 'Administración E2E',
      // No embedding server in the suite: semantic analysis falls back to rules.
      SIPGES_OLLAMA_URL: 'http://127.0.0.1:9',
    };
    if (runtime === 'workers') assertWorkerBuilt();
    // `localhost` is a potentially trustworthy origin, so Chromium stores the default Secure
    // cookies over plain HTTP here; the cookie spec covers the non-loopback case.
    const hostname = 'localhost';
    const databaseUrl = database.SIPGES_DATABASE_URL ?? '';
    const uploadDir = path.join(scratch.dir, 'uploads');
    let api: RunningApi;
    if (runtime === 'workers') {
      api = await startWorker({
        hostname,
        databaseUrl,
        stateDir: scratch.dir,
        env: { ...shared, SIPGES_ALLOWED_HOSTS: hostname },
      });
    } else if (goBinary) {
      // Go does not migrate on start; `migrate` applies the same SQL files the Node API does.
      await migrateGoApi(goBinary, goMigrateEnv({ databaseUrl, migrationsDir }));
      api = await startGoApi(goBinary, {
        hostname,
        env: goApiEnv({ databaseUrl, webDir: webDist, uploadDir, hostname, shared }),
      });
    } else {
      api = await startApi({
        hostname,
        env: { ...database, ...shared, SIPGES_UPLOAD_DIR: uploadDir, SIPGES_WEB_DIR: webDist },
      });
    }
    register(api.stop);

    process.env.SIPGES_E2E_BASE_URL = api.url;
    process.env.SIPGES_E2E_ADMIN_USERNAME = ADMIN_USERNAME;
    process.env.SIPGES_E2E_ADMIN_PASSWORD = secrets.adminPassword;
    process.env.SIPGES_E2E_DATA_KEY = secrets.dataKey;
  });
}
