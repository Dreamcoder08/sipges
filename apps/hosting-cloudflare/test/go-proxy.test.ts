import { describe, expect, it, vi } from 'vitest';
import { createGoProxy } from '../src/go-proxy.ts';

const proxy = (forward: (request: Request) => Promise<Response>) =>
  createGoProxy({ allowedHosts: ['localhost'], hsts: true, forward });

describe('Go proxy', () => {
  it('forwards the request and adds the same security headers as the TypeScript API', async () => {
    const forward = vi.fn(
      async (_request: Request) =>
        new Response('{"status":"ok"}', {
          status: 201,
          headers: { 'content-type': 'application/json', 'x-from': 'go' },
        }),
    );
    const response = await proxy(forward).fetch(
      new Request('http://localhost/system/x?y=1', {
        method: 'POST',
        body: 'b',
        headers: { host: 'localhost' },
      }),
    );

    expect(forward).toHaveBeenCalledOnce();
    const sent = forward.mock.calls[0]?.[0];
    if (!sent) throw new Error('not forwarded');
    expect(sent.method).toBe('POST');
    expect(sent.url).toBe('http://localhost/system/x?y=1');
    expect(await sent.text()).toBe('b');
    expect(response.status).toBe(201);
    expect(await response.text()).toBe('{"status":"ok"}');
    expect(response.headers.get('x-from')).toBe('go');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(response.headers.get('Content-Security-Policy')).toContain("default-src 'none'");
    expect(response.headers.get('Strict-Transport-Security')).toContain('max-age=');
  });

  it('refuses a host outside the allowlist without reaching Go', async () => {
    const forward = vi.fn(async () => new Response('go'));
    const response = await proxy(forward).fetch(
      new Request('http://evil.example/system/x', { headers: { host: 'evil.example' } }),
    );
    expect(forward).not.toHaveBeenCalled();
    expect(response.status).toBe(400);
  });

  it('answers the 503 JSON of the Worker when the container cannot be reached', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = await proxy(async () => {
      throw new Error('container failed to start postgres://secret@db');
    }).fetch(new Request('http://localhost/system/x', { headers: { host: 'localhost' } }));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ detail: 'SIPGES no está disponible temporalmente' });
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain('secret');
  });
});
