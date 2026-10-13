import { randomBytes } from 'node:crypto';
import path from 'node:path';
import postgres from 'postgres';
import {
  assertWebBuilt,
  scratchDir,
  startApi,
  syntheticSecrets,
  webDist,
} from './support/server.ts';

export const ADMIN_USERNAME = 'e2e-admin';

/**
 * Boots one isolated MASCLI instance for the suite: the real API (apps/api/src/main.ts) serving
 * the built SPA, a fresh synthetic database and generated credentials. The database is PGlite in
 * a temporary directory, or a throwaway database on the PostgreSQL server named by
 * MASCLI_E2E_DATABASE_URL (created here, dropped in the returned teardown).
 * Credentials reach the tests only through this process's environment, never through files.
 */
export default async function globalSetup() {
  assertWebBuilt();
  const scratch = await scratchDir('suite');
  const secrets = syntheticSecrets();
  const cleanups: (() => Promise<void>)[] = [scratch.remove];

  let database: Record<string, string> = { MASCLI_PGLITE_DIR: path.join(scratch.dir, 'pglite') };
  const serverUrl = process.env.MASCLI_E2E_DATABASE_URL;
  if (serverUrl) {
    const name = `mascli_e2e_${randomBytes(6).toString('hex')}`;
    const admin = postgres(serverUrl, { max: 1, onnotice: () => undefined });
    await admin.unsafe(`CREATE DATABASE ${name}`);
    const url = new URL(serverUrl);
    url.pathname = `/${name}`;
    database = { MASCLI_DATABASE_URL: url.toString() };
    cleanups.unshift(async () => {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await admin.end();
    });
  }

  const api = await startApi({
    // `localhost` is a potentially trustworthy origin, so Chromium stores the default Secure
    // cookies over plain HTTP here; the cookie spec covers the non-loopback case.
    hostname: 'localhost',
    env: {
      ...database,
      MASCLI_DATA_KEY: secrets.dataKey,
      MASCLI_ADMIN_USERNAME: ADMIN_USERNAME,
      MASCLI_ADMIN_PASSWORD: secrets.adminPassword,
      MASCLI_ADMIN_FULL_NAME: 'Administración E2E',
      MASCLI_UPLOAD_DIR: path.join(scratch.dir, 'uploads'),
      MASCLI_WEB_DIR: webDist,
      // No embedding server in the suite: semantic analysis falls back to rules.
      MASCLI_OLLAMA_URL: 'http://127.0.0.1:9',
    },
  });
  cleanups.unshift(api.stop);

  process.env.MASCLI_E2E_BASE_URL = api.url;
  process.env.MASCLI_E2E_ADMIN_USERNAME = ADMIN_USERNAME;
  process.env.MASCLI_E2E_ADMIN_PASSWORD = secrets.adminPassword;
  process.env.MASCLI_E2E_DATA_KEY = secrets.dataKey;

  return async () => {
    for (const cleanup of cleanups) await cleanup();
  };
}
