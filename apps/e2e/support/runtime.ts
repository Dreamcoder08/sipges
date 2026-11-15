/**
 * Pure helpers that choose and configure the server the suite runs against
 * (SIPGES_E2E_RUNTIME): the Node API (default), the Cloudflare Worker or the Go API.
 */
export type E2eRuntime = 'node' | 'workers' | 'go';

/** Reads SIPGES_E2E_RUNTIME; a misspelt value fails instead of silently running Node. */
export const e2eRuntime = (value: string | undefined): E2eRuntime => {
  if (value === undefined || value === '' || value === 'node') return 'node';
  if (value === 'workers' || value === 'go') return value;
  throw new Error(`SIPGES_E2E_RUNTIME must be unset, 'node', 'workers' or 'go'; got '${value}'`);
};

/** Databases the Go runtime creates (and drops) on the server of SIPGES_E2E_DATABASE_URL. */
export const GO_DATABASE_PREFIX = 'sipges_e2e_go_';

/** The server URL pointing at `name`; the name is checked because it is spliced into DDL. */
export const scratchDatabaseUrl = (serverUrl: string, name: string) => {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(name)) {
    throw new Error(`invalid scratch database name: ${JSON.stringify(name)}`);
  }
  const url = new URL(serverUrl);
  url.pathname = `/${name}`;
  return url.toString();
};

/**
 * `sipges-api-go migrate`: the SQL files are the TypeScript API's, and the synthetic test
 * server's superuser is accepted (Go allows that override on a loopback database only).
 */
export const goMigrateEnv = (options: { databaseUrl: string; migrationsDir: string }) => ({
  SIPGES_DATABASE_URL: options.databaseUrl,
  SIPGES_MIGRATIONS_DIR: options.migrationsDir,
  SIPGES_ALLOW_PRIVILEGED_DB_ROLE: '1',
});

/**
 * The Go API serving the built SPA itself: SIPGES_WEB_DIR requires a host allowlist, because
 * nothing else stands in front of Go. `shared` carries the settings every runtime gets (admin,
 * data key, MFA, cookies); what the harness owns comes last and wins.
 */
export const goApiEnv = (options: {
  databaseUrl: string;
  webDir: string;
  uploadDir: string;
  hostname: string;
  shared: Readonly<Record<string, string | undefined>>;
}): Record<string, string | undefined> => ({
  ...options.shared,
  SIPGES_DATABASE_URL: options.databaseUrl,
  SIPGES_ALLOW_PRIVILEGED_DB_ROLE: '1',
  SIPGES_WEB_DIR: options.webDir,
  SIPGES_ALLOWED_HOSTS: options.hostname,
  SIPGES_UPLOAD_DIR: options.uploadDir,
  SIPGES_ACCESS_LOG: '0',
});
