import { HealthResponse } from '@sipges/contracts';
import { beforeEach, describe, expect, it } from 'vitest';
import { healthRoutes } from '../src/contexts/system/http/health.routes.ts';
import { readinessProbe } from '../src/platform/database/readiness.ts';
import { createTestApp } from './support/test-app.ts';

let t: Awaited<ReturnType<typeof createTestApp>>;
beforeEach(async () => {
  t = await createTestApp();
});

describe('GET /health', () => {
  it('returns the Python health payload anonymously', async () => {
    const res = await t.app.request('/health');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^application\/json/);
    const body = await res.json();
    expect(HealthResponse.parse(body)).toEqual({
      status: 'ok',
      service: 'SIPGES',
      version: 'V0.5.1',
    });
  });

  it('sets the parity security headers', async () => {
    const res = await t.app.request('/health');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('requires a session before revealing whether a route exists (parity with app.py middleware)', async () => {
    const res = await t.app.request('/does-not-exist');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ detail: 'Inicie sesión para acceder a SIPGES' });
  });

  it('answers unknown routes with a FastAPI-compatible 404 body for signed-in users', async () => {
    const { cookie } = await t.login('admin', 'admin-password-123');
    const res = await t.request('/does-not-exist', { headers: { cookie } });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ detail: 'Not Found' });
  });
});

describe('GET /health/ready', () => {
  it('answers 200 anonymously once the database runs SELECT 1', async () => {
    const res = await t.app.request('/health/ready');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ready' });
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('answers 503 when the database query fails, without leaking the error', async () => {
    const app = healthRoutes({
      ready: () => Promise.reject(new Error('synthetic: connection refused to db.invalid')),
    });
    const res = await app.request('/health/ready');
    expect(res.status).toBe(503);
    const body = await res.text();
    expect(JSON.parse(body)).toEqual({ status: 'unavailable' });
    expect(body).not.toContain('db.invalid');
  });

  it('answers 503 when the database does not answer within the timeout', async () => {
    const app = healthRoutes({ ready: () => new Promise(() => {}), timeoutMs: 5 });
    const res = await app.request('/health/ready');
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ status: 'unavailable' });
  });

  it('runs exactly SELECT 1 through the SQL client', async () => {
    const queries: string[] = [];
    const app = healthRoutes({
      ready: readinessProbe({
        query: async (text: string) => {
          queries.push(text);
          return [];
        },
      }),
    });
    expect((await app.request('/health/ready')).status).toBe(200);
    expect(queries).toEqual(['SELECT 1']);
  });

  it('is never answered with the SPA shell, even for a browser navigation', async () => {
    const web = { index: async () => '<!doctype html>', asset: async () => null };
    const spa = await createTestApp({}, { web });
    const res = await spa.request('/health/ready', { headers: { accept: 'text/html' } });
    expect(res.headers.get('content-type')).toMatch(/^application\/json/);
  });
});
