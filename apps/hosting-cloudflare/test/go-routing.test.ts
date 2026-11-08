import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { CASES } from '../../parity/src/cases.ts';
import {
  GO_INSTANCE,
  GO_ROUTES,
  GO_SLEEP_AFTER,
  type GoRoute,
  goContainerEnv,
  goRoutingEnabled,
  routesToGo,
  validateGoRoutes,
} from '../src/go-routes.ts';

const backend = { idFromName: () => ({}), get: () => ({ fetch: async () => new Response() }) };

describe('Go route list', () => {
  const routes: GoRoute[] = [
    { method: 'GET', path: '/system/reference/projects' },
    { method: 'GET', path: '/api/records/:id' },
  ];

  it('matches the exact method and path, and :name as one non-empty segment', () => {
    expect(routesToGo(routes, 'GET', '/system/reference/projects')).toBe(true);
    expect(routesToGo(routes, 'GET', '/api/records/42')).toBe(true);
    expect(routesToGo(routes, 'POST', '/system/reference/projects')).toBe(false);
    expect(routesToGo(routes, 'GET', '/system/reference/projects/')).toBe(false);
    expect(routesToGo(routes, 'GET', '/system/reference')).toBe(false);
    expect(routesToGo(routes, 'GET', '/api/records/')).toBe(false);
    expect(routesToGo(routes, 'GET', '/api/records/42/files')).toBe(false);
  });

  it('refuses routes outside /api and /system, duplicates and routes without a parity case', () => {
    const parity = [{ method: 'GET', path: '/system/reference/projects?limit=1' }];
    expect(
      validateGoRoutes(
        [
          { method: 'GET', path: '/system/reference/projects' },
          { method: 'GET', path: '/system/reference/projects' },
          { method: 'GET', path: '/health' },
          { method: 'GET', path: '/system/geography/layers' },
        ],
        parity,
      ),
    ).toEqual([
      'GET /system/reference/projects: duplicate route',
      'GET /health: only /api/ and /system/ routes move to Go',
      'GET /health: no parity case in apps/parity/src/cases.ts',
      'GET /system/geography/layers: no parity case in apps/parity/src/cases.ts',
    ]);
  });

  it('every declared route is valid and has a parity case (S6)', () => {
    expect(validateGoRoutes(GO_ROUTES, CASES)).toEqual([]);
  });
});

describe('Go routing switch', () => {
  it('is off unless SIPGES_GO_ROUTING is exactly 1 and the container binding exists', () => {
    expect(goRoutingEnabled({})).toBe(false);
    expect(goRoutingEnabled({ SIPGES_GO_ROUTING: '1' })).toBe(false);
    expect(goRoutingEnabled({ GO_BACKEND: backend })).toBe(false);
    expect(goRoutingEnabled({ GO_BACKEND: backend, SIPGES_GO_ROUTING: 'true' })).toBe(false);
    expect(goRoutingEnabled({ GO_BACKEND: backend, SIPGES_GO_ROUTING: '1' })).toBe(true);
  });
});

describe('Go container', () => {
  it('passes only the settings the Go API reads, listening on all interfaces', () => {
    expect(
      goContainerEnv({
        SIPGES_GO_DATABASE_URL: 'postgres://synthetic@db.invalid/synthetic',
        SIPGES_ALLOWED_HOSTS: 'sipges.example.org',
        SIPGES_OCR: 'not-for-go',
        SIPGES_ADMIN_USERNAME: 'admin',
        SIPGES_ADMIN_PASSWORD: 'synthetic-password',
        SIPGES_ADMIN_FULL_NAME: 'Synthetic',
      }),
    ).toEqual({
      SIPGES_HOST: '0.0.0.0',
      SIPGES_PORT: '8080',
      SIPGES_TRUST_CF_CONNECTING_IP: '1',
      SIPGES_ALLOWED_HOSTS: 'sipges.example.org',
      SIPGES_DATABASE_URL: 'postgres://synthetic@db.invalid/synthetic',
      SIPGES_ADMIN_USERNAME: 'admin',
      SIPGES_ADMIN_PASSWORD: 'synthetic-password',
      SIPGES_ADMIN_FULL_NAME: 'Synthetic',
    });
    expect(goContainerEnv({})).toEqual({
      SIPGES_HOST: '0.0.0.0',
      SIPGES_PORT: '8080',
      SIPGES_TRUST_CF_CONNECTING_IP: '1',
    });
  });

  it('passes the cron secret and schedule, and only when they are set', () => {
    const synthetic = 'synthetic-cron-value-of-24+chars';
    expect(
      goContainerEnv({
        SIPGES_CRON_SECRET: synthetic,
        CRON_SECRET: 'fallback',
        SIPGES_CRON_SCHEDULE: '*/15 * * * *',
      }),
    ).toMatchObject({
      SIPGES_CRON_SECRET: synthetic,
      CRON_SECRET: 'fallback',
      SIPGES_CRON_SCHEDULE: '*/15 * * * *',
    });
    expect(Object.keys(goContainerEnv({}))).not.toContain('SIPGES_CRON_SECRET');
    expect(Object.keys(goContainerEnv({}))).not.toContain('SIPGES_CRON_SCHEDULE');
  });

  it('passes every setting real routes need, and only when it is set', () => {
    const names = [
      'SIPGES_REQUIRE_MFA',
      'SIPGES_COOKIE_SECURE',
      'SIPGES_ACCESS_LOG',
      'SIPGES_DATA_KEY',
      'SIPGES_DATA_KEY_PREVIOUS',
      'SIPGES_STORAGE',
      'SIPGES_S3_ENDPOINT',
      'SIPGES_S3_REGION',
      'SIPGES_S3_BUCKET',
      'SIPGES_S3_ACCESS_KEY_ID',
      'SIPGES_S3_SECRET_ACCESS_KEY',
      'SIPGES_MAX_UPLOAD_BYTES',
      'SIPGES_GOOGLE_CLIENT_ID',
      'SIPGES_GOOGLE_CLIENT_SECRET',
      'SIPGES_GOOGLE_ADMIN_EMAIL',
      'SIPGES_VAPID_PUBLIC_KEY',
      'SIPGES_VAPID_PRIVATE_KEY',
      'SIPGES_VAPID_SUBJECT',
      'SIPGES_OLLAMA_URL',
      'SIPGES_OLLAMA_EMBED_MODEL',
      'SIPGES_SEMANTIC_SEARCH',
      'SIPGES_ANALYST_PROVIDER',
      'SIPGES_ANALYST_MODEL',
      'SIPGES_ANALYST_BASE_URL',
      'SIPGES_ANALYST_API_KEY',
      'ANTHROPIC_BASE_URL',
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_AUTH_TOKEN',
    ];
    const set = Object.fromEntries(names.map((name) => [name, `synthetic-${name}`]));
    expect(goContainerEnv(set)).toEqual({ ...goContainerEnv({}), ...set });
    for (const name of names) expect(goContainerEnv({})).not.toHaveProperty(name);
  });

  it('adds no security default: unset stays unset, so Go keeps MFA and Secure cookies on', () => {
    const unset = goContainerEnv({});
    expect(unset).not.toHaveProperty('SIPGES_REQUIRE_MFA');
    expect(unset).not.toHaveProperty('SIPGES_COOKIE_SECURE');
    expect(goContainerEnv({ SIPGES_REQUIRE_MFA: '1', SIPGES_COOKIE_SECURE: '1' })).toMatchObject({
      SIPGES_REQUIRE_MFA: '1',
      SIPGES_COOKIE_SECURE: '1',
    });
  });

  it('keeps switches that are not for this container out', () => {
    const env = goContainerEnv({
      SIPGES_ALLOW_PRIVILEGED_DB_ROLE: '1',
      SIPGES_TRUST_PROXY: '1',
      SIPGES_UPLOAD_DIR: '/unused',
      SIPGES_AUTOMATION_INTERVAL: '60',
      SIPGES_OCR: '1',
      SIPGES_OCR_LANGUAGES: 'spa',
      SIPGES_GO_ROUTING: '1',
    });
    expect(env).toEqual(goContainerEnv({}));
  });

  it('ignores bindings and logs nothing it passes', () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) =>
      vi.spyOn(console, method),
    );
    const env = goContainerEnv({ SIPGES_DATA_KEY: 'synthetic-key', SIPGES_S3_BUCKET: {} });
    expect(env).toMatchObject({ SIPGES_DATA_KEY: 'synthetic-key' });
    expect(env).not.toHaveProperty('SIPGES_S3_BUCKET');
    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    }
  });

  it('never starts the Go cron: its switch stays out of the container', () => {
    expect(goContainerEnv({ SIPGES_GO_AUTOMATION_CRON: '1' })).not.toHaveProperty(
      'SIPGES_GO_AUTOMATION_CRON',
    );
  });

  it('sleeps after 10 minutes idle in one named instance', () => {
    expect(GO_SLEEP_AFTER).toBe('10m');
    expect(GO_INSTANCE).toEqual({ name: 'go-enam', locationHint: 'enam' });
  });
});

type WranglerConfig = {
  name: string;
  vars: Record<string, string>;
  hyperdrive?: { id: string }[];
  triggers?: { crons: string[] };
  containers?: unknown;
  durable_objects?: unknown;
};

const wrangler = async (file: string) => {
  const text = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
  // JSONC: drop whole-line comments and trailing commas.
  return JSON.parse(
    text.replace(/^\s*\/\/.*$/gm, '').replace(/,(\s*[}\]])/g, '$1'),
  ) as WranglerConfig;
};

describe('Go image', () => {
  const repo = (path: string) => readFile(new URL(`../../../${path}`, import.meta.url), 'utf8');

  it('sends the embedded PDF engine to the build', async () => {
    const source = await repo('apps/api-go/internal/platform/engines/pdftext.go');
    const embedded = [...source.matchAll(/^\/\/go:embed (\S+)$/gm)].map((match) => match[1]);
    expect(embedded).toEqual(expect.arrayContaining(['wasm/pdf-text.wasm']));
    const ignore = (await repo('apps/api-go/Dockerfile.dockerignore')).split('\n');
    expect(ignore).toContain('!apps/api-go/internal');
    expect(ignore.filter((line) => line.includes('wasm') || line.includes('qbc'))).toEqual([]);
    expect(await repo('apps/api-go/Dockerfile')).toContain('COPY apps/api-go/internal ./internal');
  });
});

describe('Wrangler configuration', () => {
  it('keeps production on TypeScript: no switch, no container, no Go binding (S7)', async () => {
    const production = await wrangler('wrangler.jsonc');
    expect(production.vars.SIPGES_GO_ROUTING).toBeUndefined();
    expect(production.containers).toBeUndefined();
    expect(production.durable_objects).toBeUndefined();
  });

  it('declares the Go container in a separate Worker, constrained to ENAM', async () => {
    const go = await wrangler('wrangler.go.jsonc');
    expect(go.name).toBe('sipges-go');
    expect(go.vars.SIPGES_GO_ROUTING).toBe('1');
    expect(go.containers).toEqual([
      expect.objectContaining({
        class_name: 'GoBackend',
        image: '../api-go/Dockerfile',
        instance_type: 'basic',
        constraints: { regions: ['ENAM'] },
      }),
    ]);
    expect(go.durable_objects).toEqual({
      bindings: [{ name: 'GO_BACKEND', class_name: 'GoBackend' }],
    });
  });

  it('never points the Go Worker at production data or runs its cron', async () => {
    const [production, go] = await Promise.all([
      wrangler('wrangler.jsonc'),
      wrangler('wrangler.go.jsonc'),
    ]);
    expect(production.hyperdrive?.[0]?.id).toMatch(/^[0-9a-f]{32}$/);
    // The id is set at deploy, by go-trial-config.mjs, which refuses production's.
    expect(go.hyperdrive).toBeUndefined();
    expect(go.triggers).toBeUndefined();
    expect(go.vars.SIPGES_ALLOWED_HOSTS).not.toBe(production.vars.SIPGES_ALLOWED_HOSTS);
  });
});
