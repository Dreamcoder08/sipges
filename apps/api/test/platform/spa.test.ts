import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SPA_CSP, type WebAssets, fileWebAssets } from '../../src/platform/http/spa.ts';
import { createTestApp } from '../support/test-app.ts';

const SHELL = '<!doctype html><title>MASCLI</title><div id="root"></div>';

const memoryWeb: WebAssets = {
  index: async () => SHELL,
  asset: async (name) => (name === 'index-abc.js' ? new TextEncoder().encode('ok()') : null),
};

const html = { accept: 'text/html,application/xhtml+xml' };

describe('single-page app delivery', () => {
  it('serves the shell for client routes without a session, with a strict CSP', async () => {
    const t = await createTestApp({}, { web: memoryWeb });
    for (const path of ['/', '/login', '/eventos/abc']) {
      const res = await t.request(path, { headers: html });
      expect(res.status, path).toBe(200);
      expect(await res.text()).toBe(SHELL);
      expect(res.headers.get('content-security-policy')).toBe(SPA_CSP);
      expect(res.headers.get('x-frame-options')).toBe('DENY');
      expect(res.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
    }
    expect(SPA_CSP).not.toContain('unsafe');
  });

  it('serves hashed assets and refuses unknown or unsafe names', async () => {
    const t = await createTestApp({}, { web: memoryWeb });
    const js = await t.request('/assets/index-abc.js');
    expect(js.status).toBe(200);
    expect(js.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    for (const path of ['/assets/missing.js', '/assets/index.exe', '/assets/..%2Fsecret.js']) {
      expect((await t.request(path)).status, path).toBe(404);
    }
  });

  it('leaves API paths, JSON requests and writes to the API', async () => {
    const t = await createTestApp({}, { web: memoryWeb });
    const api = await t.request('/api/eventos', { headers: html });
    expect(api.status).toBe(401);
    expect(api.headers.get('referrer-policy')).toBe('no-referrer');
    expect(
      (await t.request('/system/auth/me', { headers: html })).headers.get('content-type'),
    ).toContain('application/json');
    expect((await t.request('/health', { headers: html })).headers.get('content-type')).toContain(
      'application/json',
    );
    expect((await t.request('/eventos')).status).toBe(401);
    const login = await t.request('/login', {
      method: 'POST',
      headers: html,
      body: new URLSearchParams(),
    });
    expect(login.headers.get('content-type')).toContain('application/json');
  });

  it('serves nothing extra when no web build is configured', async () => {
    const t = await createTestApp();
    expect((await t.request('/', { headers: html })).status).toBe(401);
  });

  it('reads a Vite build directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mascli-web-'));
    await mkdir(join(dir, 'assets'));
    await writeFile(join(dir, 'index.html'), SHELL);
    await writeFile(join(dir, 'assets', 'app-1.css'), 'body{}');
    const web = fileWebAssets(dir);
    expect(await web.index()).toBe(SHELL);
    expect(new TextDecoder().decode((await web.asset('app-1.css')) ?? new Uint8Array())).toBe(
      'body{}',
    );
    expect(await web.asset('../index.html')).toBeNull();
    expect(await fileWebAssets(join(dir, 'missing')).index()).toBeNull();
  });
});
