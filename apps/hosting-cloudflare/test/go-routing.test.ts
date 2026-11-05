import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
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
        SIPGES_DATA_KEY: 'not-for-go',
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

  it('sleeps after 10 minutes idle in one named instance', () => {
    expect(GO_SLEEP_AFTER).toBe('10m');
    expect(GO_INSTANCE).toEqual({ name: 'go-enam', locationHint: 'enam' });
  });
});

type WranglerConfig = {
  name: string;
  vars: Record<string, string>;
  hyperdrive: { id: string }[];
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
    expect(go.hyperdrive[0]?.id).not.toBe(production.hyperdrive[0]?.id);
    expect(go.triggers).toBeUndefined();
    expect(go.vars.SIPGES_ALLOWED_HOSTS).not.toBe(production.vars.SIPGES_ALLOWED_HOSTS);
  });
});
