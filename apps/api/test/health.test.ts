import { HealthResponse } from '@mascli/contracts';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.ts';
import { loadConfig } from '../src/platform/config.ts';

const app = createApp({ config: loadConfig({}) });

describe('GET /health', () => {
  it('returns the Python health payload anonymously', async () => {
    const res = await app.request('/health');
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
    const res = await app.request('/health');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('answers unknown routes with a FastAPI-compatible 404 body', async () => {
    const res = await app.request('/does-not-exist');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ detail: 'Not Found' });
  });
});
