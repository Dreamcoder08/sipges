import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SPA_CSP, fileWebAssets } from '../../src/platform/http/spa.ts';
import { createTestApp } from '../support/test-app.ts';

/**
 * What answers without a session (functional-10 T9, risk item 2). Every candidate is requested
 * with no cookie; the ones in PUBLIC must answer 200 and every other one keeps the status it had
 * before T9. A path that becomes public, or stops being, fails here first.
 */
const PUBLIC = [
  '/favicon.ico',
  '/favicon.svg',
  '/robots.txt',
  '/manifest.webmanifest',
  '/sw.js',
  '/icon.svg',
  '/assets/index-abc123.js',
  '/assets/index-abc123.css',
  '/cesium/Workers/worker.js',
  '/health',
  '/health/ready',
  // The sign-in screen asks who is signed in (nobody) and which sign-in methods exist.
  '/system/auth/me',
  '/system/auth/providers',
];

/** A sample of other paths, with the status each answers without a session (unchanged by T9). */
const PROTECTED: ReadonlyArray<readonly [string, number]> = [
  ['/', 401],
  ['/inicio', 401],
  ['/index.html', 401],
  ['/api/eventos', 401],
  ['/system/model-status', 401],
  ['/system/auth/scopes', 401],
  ['/favicon.png', 401],
  ['/apple-touch-icon.png', 401],
  ['/robots', 401],
  ['/sitemap.xml', 401],
  ['/assets/index-abc123.js.br', 404],
  ['/assets/index-abc123.js.gz', 404],
  ['/assets/missing.js', 404],
];

/** Browser navigations get the shell whatever the client route; the API's own paths never do. */
const NAVIGATIONS: ReadonlyArray<readonly [string, number]> = [
  ['/', 200],
  ['/inicio', 200],
  ['/login', 200],
  ['/configuracion', 200],
  ['/api/eventos', 401],
  ['/system/model-status', 401],
];

const BUILD: Readonly<Record<string, string>> = {
  'index.html': '<!doctype html><title>SIPGES</title><div id="root"></div>',
  'favicon.ico': 'ico',
  'favicon.svg': '<svg/>',
  'robots.txt': 'User-agent: *\nDisallow: /\n',
  'manifest.webmanifest': '{}',
  'sw.js': 'self.x=1',
  'icon.svg': '<svg/>',
  'assets/index-abc123.js': 'ok()',
  'assets/index-abc123.js.br': 'br bytes',
  'assets/index-abc123.js.gz': 'gzip bytes',
  'assets/index-abc123.css': 'a{}',
  'cesium/Workers/worker.js': 'w()',
  'secret.txt': 'never served',
};

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const syntheticBuild = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sipges-public-'));
  dirs.push(dir);
  for (const [name, body] of Object.entries(BUILD)) {
    await mkdir(join(dir, name, '..'), { recursive: true });
    await writeFile(join(dir, name), body);
  }
  return dir;
};

describe('paths public without a session', () => {
  it('lists exactly which paths answer without a session', async () => {
    const t = await createTestApp({}, { web: fileWebAssets(await syntheticBuild()) });
    const candidates = [...PUBLIC, ...PROTECTED.map(([path]) => path)];
    const statuses = await Promise.all(
      candidates.map(async (path) => [path, (await t.request(path)).status] as const),
    );
    expect(statuses.filter(([, status]) => status === 200).map(([path]) => path)).toEqual(PUBLIC);
    expect(Object.fromEntries(statuses.filter(([path]) => !PUBLIC.includes(path)))).toEqual(
      Object.fromEntries(PROTECTED),
    );
  });

  it('keeps browser navigations on the shell and the API behind its session', async () => {
    const t = await createTestApp({}, { web: fileWebAssets(await syntheticBuild()) });
    for (const [path, status] of NAVIGATIONS) {
      const res = await t.request(path, { headers: { accept: 'text/html,application/xhtml+xml' } });
      expect(res.status, path).toBe(status);
    }
  });

  it('serves robots.txt that asks every crawler to stay out, and the icons, under the SPA policy', async () => {
    const t = await createTestApp({}, { web: fileWebAssets(await syntheticBuild()) });
    const robots = await t.request('/robots.txt');
    expect(robots.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(await robots.text()).toBe('User-agent: *\nDisallow: /\n');
    for (const [path, type] of [
      ['/favicon.ico', 'image/x-icon'],
      ['/favicon.svg', 'image/svg+xml'],
    ] as const) {
      const res = await t.request(path);
      expect(res.headers.get('content-type'), path).toBe(type);
      expect(res.headers.get('content-security-policy'), path).toBe(SPA_CSP);
      expect(res.headers.get('x-content-type-options'), path).toBe('nosniff');
    }
  });
});
