import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMetrics } from '../../src/platform/observability/metrics.ts';
import { createTestApp } from '../support/test-app.ts';

afterEach(() => vi.restoreAllMocks());

describe('observability', () => {
  it('tags responses with a request id and server timing, keeping safe caller ids', async () => {
    const t = await createTestApp();
    const res = await t.request('/health');
    expect(res.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.headers.get('server-timing')).toMatch(/^app;dur=\d+(\.\d)?$/);
    const kept = await t.request('/health', { headers: { 'x-request-id': 'trace-12345678' } });
    expect(kept.headers.get('x-request-id')).toBe('trace-12345678');
    const replaced = await t.request('/health', {
      headers: { 'x-request-id': 'bad id "quoted" value' },
    });
    expect(replaced.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('writes one JSON access line per request with route pattern and actor', async () => {
    const t = await createTestApp({ SIPGES_ACCESS_LOG: '1' });
    const admin = await t.login('admin', 'admin-password-123');
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    await t.request('/api/eventos/EV-404?secret=1', { headers: { cookie: admin.cookie } });
    const lines = info.mock.calls.map(
      ([line]) => JSON.parse(String(line)) as Record<string, unknown>,
    );
    expect(lines).toEqual([
      expect.objectContaining({
        level: 'info',
        msg: 'request',
        method: 'GET',
        route: '/api/:module/:id',
        path: '/api/eventos/EV-404',
        status: 404,
        actor: 'admin',
        request_id: expect.any(String),
      }),
    ]);
    expect(JSON.stringify(lines)).not.toContain('secret');
    expect(JSON.stringify(lines)).not.toContain('sipges_session');
  });

  it('serves Prometheus metrics to administrators only', async () => {
    const t = await createTestApp();
    const admin = await t.login('admin', 'admin-password-123');
    await t.request('/api/eventos', { headers: { cookie: admin.cookie } });
    const res = await t.request('/system/metrics', { headers: { cookie: admin.cookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain; version=0.0.4');
    const text = await res.text();
    expect(text).toContain(
      'sipges_http_requests_total{method="GET",route="/api/:module",status="2xx"} 1',
    );
    expect(text).toContain('sipges_process_uptime_seconds');
    await t.createAccount(admin.cookie, {
      username: 'reader',
      full_name: 'Reader',
      password: 'reader-password-123',
      role: 'consulta',
    });
    await t.grant(admin.cookie, 'reader');
    const reader = await t.login('reader', 'reader-password-123');
    expect(
      (await t.request('/system/metrics', { headers: { cookie: reader.cookie } })).status,
    ).toBe(403);
    expect((await t.request('/system/metrics')).status).toBe(401);
  });
});

describe('createMetrics', () => {
  it('renders counters and cumulative histogram buckets', () => {
    const metrics = createMetrics(0);
    metrics.observe('GET', '/x', 200, 0.02);
    metrics.observe('GET', '/x', 503, 3);
    const text = metrics.render(5000);
    expect(text).toContain('sipges_http_requests_total{method="GET",route="/x",status="2xx"} 1');
    expect(text).toContain('sipges_http_requests_total{method="GET",route="/x",status="5xx"} 1');
    expect(text).toContain(
      'sipges_http_request_duration_seconds_bucket{method="GET",route="/x",le="0.025"} 1',
    );
    expect(text).toContain(
      'sipges_http_request_duration_seconds_bucket{method="GET",route="/x",le="5"} 2',
    );
    expect(text).toContain('sipges_http_request_duration_seconds_count{method="GET",route="/x"} 2');
    expect(text).toContain('sipges_process_uptime_seconds 5.000');
  });
});
