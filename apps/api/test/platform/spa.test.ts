import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ASSET_CACHE,
  CESIUM_CACHE,
  SPA_CSP,
  type WebAssets,
  fileWebAssets,
  webAssetsFrom,
} from '../../src/platform/http/spa.ts';
import { createTestApp } from '../support/test-app.ts';

const SHELL = '<!doctype html><title>SIPGES</title><div id="root"></div>';

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
    // Hashed names never change meaning: cached for a year by browsers and the CDN.
    expect(js.headers.get('cache-control')).toBe(ASSET_CACHE);
    expect(js.headers.get('x-content-type-options')).toBe('nosniff');
    const shell = await t.request('/eventos', { headers: html });
    expect(shell.headers.get('cache-control')).toBe('no-store');
    expect((await t.request('/assets/missing.js')).headers.get('cache-control')).toBe('no-store');
    for (const path of ['/assets/missing.js', '/assets/index.exe', '/assets/..%2Fsecret.js']) {
      expect((await t.request(path)).status, path).toBe(404);
    }
  });

  it('serves the CesiumJS workers and assets under the SPA policy, refusing anything else', async () => {
    const read: string[] = [];
    const web: WebAssets = {
      ...memoryWeb,
      cesium: async (path) => {
        read.push(path);
        return path === 'Workers/createVerticesFromHeightmap.js'
          ? new TextEncoder().encode('w()')
          : null;
      },
    };
    const t = await createTestApp({}, { web });
    const worker = await t.request('/cesium/Workers/createVerticesFromHeightmap.js');
    expect(worker.status).toBe(200);
    expect(worker.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(worker.headers.get('cache-control')).toBe(CESIUM_CACHE);
    // A module worker runs under its own response's CSP.
    expect(worker.headers.get('content-security-policy')).toBe(SPA_CSP);
    expect(SPA_CSP).toContain('https://s3.amazonaws.com');
    for (const path of [
      '/cesium/Workers/missing.js',
      '/cesium/Source/Core/x.js',
      '/cesium/Assets/%2e%2e/secret.json',
      '/cesium/Assets/x.exe',
    ])
      expect((await t.request(path)).status, path).toBe(404);
    expect(read).toEqual(['Workers/createVerticesFromHeightmap.js', 'Workers/missing.js']);
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

  it('serves the installable-app files from the build root, never cached', async () => {
    const files: Record<string, string> = { 'sw.js': 'self.x=1', 'manifest.webmanifest': '{}' };
    const web: WebAssets = {
      ...memoryWeb,
      rootFile: async (name) => (name in files ? new TextEncoder().encode(files[name]) : null),
    };
    const t = await createTestApp({}, { web });
    const sw = await t.request('/sw.js');
    expect(sw.status).toBe(200);
    expect(sw.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(sw.headers.get('cache-control')).toBe('no-store');
    expect(sw.headers.get('content-security-policy')).toBe(SPA_CSP);
    expect(await sw.text()).toBe('self.x=1');
    expect((await t.request('/manifest.webmanifest')).headers.get('content-type')).toBe(
      'application/manifest+json',
    );
    expect((await t.request('/icon.svg')).status).toBe(404);
    expect((await (await createTestApp({}, { web: memoryWeb })).request('/sw.js')).status).toBe(
      404,
    );
  });

  it('serves nothing extra when no web build is configured', async () => {
    const t = await createTestApp();
    expect((await t.request('/', { headers: html })).status).toBe(401);
  });

  it('reads a Vite build directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sipges-web-'));
    await mkdir(join(dir, 'assets'));
    await writeFile(join(dir, 'index.html'), SHELL);
    await writeFile(join(dir, 'assets', 'app-1.css'), 'body{}');
    const web = fileWebAssets(dir);
    expect(await web.index()).toBe(SHELL);
    expect(new TextDecoder().decode((await web.asset('app-1.css')) ?? new Uint8Array())).toBe(
      'body{}',
    );
    expect(await web.asset('../index.html')).toBeNull();
    await writeFile(join(dir, 'sw.js'), 'self.x=1');
    expect(new TextDecoder().decode((await web.rootFile?.('sw.js')) ?? new Uint8Array())).toBe(
      'self.x=1',
    );
    expect(await web.rootFile?.('index.html')).toBeNull();
    await mkdir(join(dir, 'cesium', 'Assets'), { recursive: true });
    await writeFile(join(dir, 'cesium', 'Assets', 'heights.json'), '{}');
    expect(
      new TextDecoder().decode((await web.cesium?.('Assets/heights.json')) ?? new Uint8Array()),
    ).toBe('{}');
    expect(await web.cesium?.('../index.html')).toBeNull();
    expect(await fileWebAssets(join(dir, 'missing')).index()).toBeNull();
  });
});

describe('webAssetsFrom', () => {
  it('maps valid names to build paths and never passes an unsafe name to the source', async () => {
    const reads: string[] = [];
    const web = webAssetsFrom(async (path) => {
      reads.push(path);
      return new TextEncoder().encode(`bytes of ${path}`);
    });
    expect(await web.index()).toBe('bytes of index.html');
    expect(await web.asset('index-abc123.js')).not.toBeNull();
    expect(await web.rootFile?.('sw.js')).not.toBeNull();
    for (const unsafe of ['../index.html', '..%2Fsecret', 'a/b.js', '']) {
      expect(await web.asset(unsafe)).toBeNull();
      expect(await web.cesium?.(unsafe)).toBeNull();
    }
    expect(await web.rootFile?.('index.html')).toBeNull();
    expect(reads).toEqual(['index.html', 'assets/index-abc123.js', 'sw.js']);
  });
});
