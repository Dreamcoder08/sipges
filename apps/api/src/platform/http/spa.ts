import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import type { MiddlewareHandler } from 'hono';

/** Built single-page app (apps/web/dist): its HTML shell and its hashed assets. */
export type WebAssets = {
  index(): Promise<string | null>;
  asset(name: string): Promise<Uint8Array | null>;
  /** One of ROOT_FILES from the build root (Vite's `public/` directory). */
  rootFile?(name: string): Promise<Uint8Array | null>;
};

/** Installable-app files that must live at the site root (docs/adr/0014). */
const ROOT_FILES: Readonly<Record<string, string>> = {
  '/manifest.webmanifest': 'application/manifest+json',
  '/sw.js': 'text/javascript; charset=utf-8',
  '/icon.svg': 'image/svg+xml',
};

/**
 * Strict policy for the SPA (ADR 0004, ADR 0006): bundled scripts and styles only, no inline
 * code, same-origin API calls. React sets styles through the CSSOM, which `style-src` allows.
 * External origins are the basemap tile hosts and INGEMMET's cadastre images. MapLibre fetches
 * raster tiles (connect-src) and may decode them through blob: images (ADR 0017).
 */
export const SPA_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob: https://tile.openstreetmap.org https://tiles.maps.eox.at https://geocatmin.ingemmet.gob.pe",
  "font-src 'self'",
  "connect-src 'self' https://tile.openstreetmap.org https://tiles.maps.eox.at https://s3.amazonaws.com",
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

/**
 * Vite puts a content hash in every asset name, so a name never changes meaning: browsers and
 * the CDN keep it for a year. Sending `no-store` here made every visit and every screen
 * download the whole bundle again through the server function.
 */
export const ASSET_CACHE = 'public, max-age=31536000, s-maxage=31536000, immutable';

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
    const rootType = Object.hasOwn(ROOT_FILES, path) ? ROOT_FILES[path] : undefined;
    if (rootType) {
      const bytes = web.rootFile ? await web.rootFile(path.slice(1)) : null;
      if (!bytes) return c.json({ detail: 'Not Found' }, 404);
      // The worker runs under its own CSP: the SPA policy lets it show the app icon.
      return c.body(new Uint8Array(bytes), 200, {
        'Content-Type': rootType,
        'Content-Security-Policy': SPA_CSP,
      });
    }
    if (path.startsWith('/assets/')) {
      const name = path.slice('/assets/'.length);
      const type = ASSET_TYPES[extname(name)];
      const bytes = type && ASSET_NAME.test(name) ? await web.asset(name) : null;
      if (!type || !bytes) return c.json({ detail: 'Not Found' }, 404);
      return c.body(new Uint8Array(bytes), 200, {
        'Content-Type': type,
        'Cache-Control': ASSET_CACHE,
      });
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
  async rootFile(name) {
    if (!Object.hasOwn(ROOT_FILES, `/${name}`)) return null;
    try {
      return await readFile(join(dir, name));
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
