import { createApp } from '../src/app.ts';
import { buildContainer } from '../src/compose.ts';
import { totp } from '../src/contexts/identity/infrastructure/totp.ts';
import type { EmbeddingProvider } from '../src/contexts/intelligence/application/index.ts';
import { loadConfig } from '../src/platform/config.ts';
import type { SqlClient } from '../src/platform/database/sql-client.ts';

export const BENCHMARK_HTTP_PATHS = [
  '/api/dashboard',
  '/system/irsa',
  '/system/situational-analysis',
  '/system/integrated-analysis',
  '/system/consensus-engine',
  '/system/strategic-assessment',
  '/api/eventos?limit=-1',
] as const;

/** Shared by the runner and its public-HTTP regression, on an isolated migrated database. */
export const createBenchmarkSession = async (sql: SqlClient, embeddings: EmbeddingProvider) => {
  const config = loadConfig({
    SIPGES_DATA_KEY: Buffer.alloc(32, 7).toString('base64'),
    SIPGES_ADMIN_PASSWORD: 'synthetic-bench-password',
    SIPGES_COOKIE_SECURE: '0',
  });
  const container = await buildContainer({
    config,
    sql,
    clock: { now: () => new Date() },
    clientIp: () => '203.0.113.9',
    embeddings,
  });
  const app = createApp(container);
  const login = await app.request('/login', {
    method: 'POST',
    headers: { host: 'localhost', origin: 'http://localhost' },
    body: new URLSearchParams({ username: 'admin', password: 'synthetic-bench-password', otp: '' }),
  });
  const sessionCookie = /sipges_session=[^;]*/.exec(login.headers.get('set-cookie') ?? '')?.[0];
  if (login.status !== 200 || !sessionCookie)
    throw new Error(`Benchmark login failed: ${login.status}`);
  const headers = { host: 'localhost', origin: 'http://localhost', cookie: sessionCookie };
  // Enroll the disposable admin through the same MFA endpoints as a browser; keep the guard on.
  const setup = await app.request('/system/auth/totp/setup', { method: 'POST', headers });
  if (setup.status !== 200) throw new Error(`Benchmark MFA setup failed: ${setup.status}`);
  const setupBody = await setup.json();
  if (
    typeof setupBody !== 'object' ||
    setupBody === null ||
    !('secret' in setupBody) ||
    typeof setupBody.secret !== 'string'
  )
    throw new Error('Benchmark MFA setup returned an invalid secret');
  const { secret } = setupBody;
  const enabled = await app.request('/system/auth/totp/enable', {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ code: totp.codeAt(secret, new Date()) }),
  });
  if (enabled.status !== 200) throw new Error(`Benchmark MFA enrollment failed: ${enabled.status}`);
  const selected = await app.request('/select-project', {
    method: 'POST',
    headers,
    body: new URLSearchParams({ scope: 'SIPGES/PRJ-SECHURA' }),
  });
  const scopeCookie = /sipges_scope=[^;]*/.exec(selected.headers.get('set-cookie') ?? '')?.[0];
  if (selected.status !== 303 || !scopeCookie)
    throw new Error(`Benchmark project selection failed: ${selected.status}`);
  const cookie = `${sessionCookie}; ${scopeCookie}`;
  const get = async (path: string) => {
    const response = await app.request(path, { headers: { host: 'localhost', cookie } });
    if (response.status !== 200) throw new Error(`${path} answered ${response.status}`);
    await response.arrayBuffer();
  };
  return { app, cookie, get };
};
