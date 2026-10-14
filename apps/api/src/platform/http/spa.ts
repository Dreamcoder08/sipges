import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import type { MiddlewareHandler } from 'hono';

/** Built single-page app (apps/web/dist): its HTML shell and its hashed assets. */
export type WebAssets = {
  index(): Promise<string | null>;
  asset(name: string): Promise<Uint8Array | null>;
};

/**
 * Strict policy for the SPA (ADR 0004, ADR 0006): bundled scripts and styles only, no inline
 * code, same-origin API calls. React sets styles through the CSSOM, which `style-src` allows.
 * The only external origin is the basemap tile host of the territorial map (images only).
 */
export const SPA_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: https://tile.openstreetmap.org",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

const ASSET_TYPES: Readonly<Record<string, string>> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
};

const ASSET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** Paths the API owns; everything else a browser navigates to is a client route. */
const API_PREFIXES = ['/api/', '/system/', '/auth/'];
const API_PATHS = new Set(['/health', '/select-project', '/logout']);

const isClientRoute = (path: string) =>
  !API_PATHS.has(path) && !API_PREFIXES.some((prefix) => path.startsWith(prefix));

/**
 * Serves the SPA before authentication: the shell and bundle hold no tenant data, and the app
 * itself asks the API who is signed in. Only GET/HEAD navigations and `/assets/*` are handled.
 */
export const spaMiddleware =
  (web: WebAssets): MiddlewareHandler =>
  async (c, next) => {
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') return next();
    const path = c.req.path;
    if (path.startsWith('/assets/')) {
      const name = path.slice('/assets/'.length);
      const type = ASSET_TYPES[extname(name)];
      const bytes = type && ASSET_NAME.test(name) ? await web.asset(name) : null;
      if (!type || !bytes) return c.json({ detail: 'Not Found' }, 404);
      return c.body(new Uint8Array(bytes), 200, { 'Content-Type': type });
    }
    if (!isClientRoute(path) || !(c.req.header('accept') ?? '').includes('text/html')) {
      return next();
    }
    const html = await web.index();
    if (html === null) return next();
    c.header('Content-Security-Policy', SPA_CSP);
    c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    return c.html(html);
  };

/** Reads a Vite build directory; asset names are validated before they reach the path. */
export const fileWebAssets = (dir: string): WebAssets => ({
  async index() {
    try {
      return await readFile(join(dir, 'index.html'), 'utf8');
    } catch {
      return null;
    }
  },
  async asset(name) {
    if (!ASSET_NAME.test(name)) return null;
    try {
      return await readFile(join(dir, 'assets', name));
    } catch {
      return null;
    }
  },
});
