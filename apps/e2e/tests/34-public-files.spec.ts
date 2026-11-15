import { request as requestFactory } from '@playwright/test';
import { expect, test } from '../support/fixtures.ts';

/**
 * functional-10 T9 (F25, F26) through the real Node server and the real build: the tab icons and
 * the crawler rule answer without a session, everything else still asks for one, and hashed
 * assets travel compressed when the client accepts it.
 */

/** A request context with no cookie at all: what a crawler or a signed-out tab sends. */
const anonymous = (baseURL: string | undefined) =>
  requestFactory.newContext({ baseURL: baseURL ?? '' });

test('the icons and robots.txt answer without a session; other paths keep asking for one', async ({
  baseURL,
}) => {
  const api = await anonymous(baseURL);
  try {
    const robots = await api.get('/robots.txt');
    expect(robots.status()).toBe(200);
    expect(robots.headers()['content-type']).toBe('text/plain; charset=utf-8');
    expect(await robots.text()).toBe('User-agent: *\nDisallow: /\n');

    const ico = await api.get('/favicon.ico');
    expect(ico.status()).toBe(200);
    expect(ico.headers()['content-type']).toBe('image/x-icon');
    // An ICO file starts with reserved 0, type 1 (icon).
    expect([...(await ico.body()).subarray(0, 4)]).toEqual([0, 0, 1, 0]);

    const svg = await api.get('/favicon.svg');
    expect(svg.status()).toBe(200);
    expect(svg.headers()['content-type']).toBe('image/svg+xml');
    expect(await svg.text()).toContain('<svg');

    for (const path of ['/api/eventos', '/system/model-status', '/inicio', '/favicon.png']) {
      const res = await api.get(path, { headers: { accept: 'application/json' } });
      expect(res.status(), path).toBe(401);
    }
  } finally {
    await api.dispose();
  }
});

test('the sign-in page links the tab icons, and the browser loads them', async ({ page }) => {
  await page.goto('/login');
  await expect(page.getByRole('button', { name: 'Ingresar' })).toBeVisible();
  const links = page.locator('link[rel="icon"]');
  await expect(links).toHaveCount(2);
  expect(await links.evaluateAll((all) => all.map((link) => link.getAttribute('href')))).toEqual([
    '/favicon.ico',
    '/favicon.svg',
  ]);
  // Headless Chromium never asks for the tab icon itself, so the signed-out page decodes each
  // linked one as an image, under its own CSP.
  const sizes = await links.evaluateAll((all) =>
    Promise.all(
      all.map(async (link) => {
        const image = new Image();
        image.src = (link as HTMLLinkElement).href;
        await image.decode();
        return [link.getAttribute('href'), image.naturalWidth > 0];
      }),
    ),
  );
  expect(sizes).toEqual([
    ['/favicon.ico', true],
    ['/favicon.svg', true],
  ]);
});

test('hashed assets travel as brotli or gzip when the client accepts them, plain otherwise', async ({
  page,
  baseURL,
}) => {
  const entry = page.waitForResponse((r) => /\/assets\/index-[^/]+\.js$/.test(r.url()));
  await page.goto('/login');
  const browserLoad = await entry;
  // Chromium asks for br; the Node server answers with the variant the build wrote.
  expect(browserLoad.headers()['content-encoding']).toBe('br');
  expect(browserLoad.headers()['vary']).toBe('Accept-Encoding');
  const path = new URL(browserLoad.url()).pathname;

  const api = await anonymous(baseURL);
  try {
    const plain = await api.get(path, { headers: { 'accept-encoding': 'identity' } });
    expect(plain.status()).toBe(200);
    expect(plain.headers()['content-encoding']).toBeUndefined();
    const original = await plain.body();
    for (const encoding of ['br', 'gzip'] as const) {
      const res = await api.get(path, { headers: { 'accept-encoding': encoding } });
      const headers = res.headers();
      expect(headers['content-encoding'], encoding).toBe(encoding);
      expect(headers['vary'], encoding).toBe('Accept-Encoding');
      expect(headers['content-type'], encoding).toBe(plain.headers()['content-type']);
      expect(headers['cache-control'], encoding).toBe(plain.headers()['cache-control']);
      expect(Number(headers['content-length']), encoding).toBeLessThan(original.length);
      // Playwright decodes the body: the variant holds the same script.
      expect((await res.body()).equals(original), encoding).toBe(true);
    }
  } finally {
    await api.dispose();
  }
});
