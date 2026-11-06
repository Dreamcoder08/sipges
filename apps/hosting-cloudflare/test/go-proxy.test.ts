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

  // @cloudflare/containers 0.3.7 (dist/lib/container.js) returns these instead of throwing.
  it.each([
    [503, 'There is no Container instance available at this time.'],
    [429, 'rate limited postgres://secret@db'],
    [500, 'Failed to start container: postgres://secret@db'],
    [500, 'Container suddenly disconnected, try again'],
    [500, 'Error proxying request to container: postgres://secret@db'],
  ])('turns the library failure %i "%s" into the 503 JSON of the Worker', async (status, text) => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    log.mockClear();
    const response = await proxy(async () => new Response(text, { status })).fetch(
      new Request('http://localhost/system/x', { headers: { host: 'localhost' } }),
    );
    expect(response.status).toBe(503);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(await response.text()).toBe('{"detail":"SIPGES no está disponible temporalmente"}');
    expect(response.headers.get('X-Request-Id')).toBeTruthy();
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Content-Security-Policy')).toContain("default-src 'none'");
    expect(log).toHaveBeenCalledOnce();
    expect(JSON.stringify(log.mock.calls)).not.toContain('secret');
  });

  it.each([429, 500, 503])('keeps the JSON failure %i that Go itself answers', async (status) => {
    const body = '{"detail":"from go"}';
    const response = await proxy(
      async () =>
        new Response(body, {
          status,
          headers: { 'content-type': 'application/json; charset=utf-8' },
        }),
    ).fetch(new Request('http://localhost/system/x', { headers: { host: 'localhost' } }));
    expect(response.status).toBe(status);
    expect(await response.text()).toBe(body);
  });

  it('keeps answers from Go that are not JSON and are not failures', async () => {
    const send = (response: Response) =>
      proxy(async () => response).fetch(
        new Request('http://localhost/system/x', { headers: { host: 'localhost' } }),
      );
    const csv = await send(new Response('a,b', { headers: { 'content-type': 'text/csv' } }));
    expect(csv.status).toBe(200);
    expect(await csv.text()).toBe('a,b');
    const bad = await send(new Response('Bad Request', { status: 400 }));
    expect(bad.status).toBe(400);
    expect(await bad.text()).toBe('Bad Request');
  });
});
