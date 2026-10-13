import { HealthResponse } from '@mascli/contracts';
import { beforeEach, describe, expect, it } from 'vitest';
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
      service: 'MASCLI',
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
    expect(await res.json()).toEqual({ detail: 'Inicie sesión para acceder a MASCLI' });
  });

  it('answers unknown routes with a FastAPI-compatible 404 body for signed-in users', async () => {
    const { cookie } = await t.login('admin', 'admin-password-123');
    const res = await t.request('/does-not-exist', { headers: { cookie } });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ detail: 'Not Found' });
  });
});
