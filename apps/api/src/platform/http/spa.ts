import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import type { MiddlewareHandler } from 'hono';

/** Built single-page app (apps/web/dist): its HTML shell and its hashed assets. */
export type WebAssets = {
  index(): Promise<string | null>;
  asset(name: string): Promise<Uint8Array | null>;
  /** One of ROOT_FILES from the build root (Vite's `public/` directory). */
  rootFile?(name: string): Promise<Uint8Array | null>;
  /** A CesiumJS worker or asset under `cesium/` (ADR 0026); `path` is already validated. */
  cesium?(path: string): Promise<Uint8Array | null>;
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
 * raster tiles (connect-src) and may decode them through blob: images (ADR 0017). The 3D view
 * reads open elevation tiles from AWS (connect-src) and runs CesiumJS workers from /cesium/.
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

/** CesiumJS files copied by the web build: workers, third-party code and engine assets. */
const CESIUM_PATH = /^(Workers|ThirdParty|Assets)(\/[A-Za-z0-9_][A-Za-z0-9._-]{0,127}){1,4}$/;
const CESIUM_TYPES: Readonly<Record<string, string>> = {
  ...ASSET_TYPES,
  '.jpg': 'image/jpeg',
  '.xml': 'application/xml',
};
/** Cesium file names carry no hash, so they are kept for a day rather than a year. */
export const CESIUM_CACHE = 'public, max-age=86400';
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
    if (path.startsWith('/cesium/')) {
      const file = path.slice('/cesium/'.length);
      const type = CESIUM_TYPES[extname(file)];
      const bytes = type && CESIUM_PATH.test(file) && web.cesium ? await web.cesium(file) : null;
      if (!type || !bytes) return c.json({ detail: 'Not Found' }, 404);
      return c.body(new Uint8Array(bytes), 200, {
        'Content-Type': type,
        'Cache-Control': CESIUM_CACHE,
        // Workers run under their own response's policy: the SPA one, not the API's.
        'Content-Security-Policy': SPA_CSP,
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
/**
 * WebAssets over any file source. Every name is validated here, before `read` sees it, so no
 * host adapter can serve a path outside the built app.
 */
export const webAssetsFrom = (
  read: (relativePath: string) => Promise<Uint8Array | null>,
): WebAssets => ({
  async index() {
    const bytes = await read('index.html');
    // ignoreBOM keeps a leading BOM, exactly as readFile(..., 'utf8') did.
    return bytes ? new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes) : null;
  },
  rootFile: async (name) => (Object.hasOwn(ROOT_FILES, `/${name}`) ? read(name) : null),
  cesium: async (path) => (CESIUM_PATH.test(path) ? read(`cesium/${path}`) : null),
  asset: async (name) => (ASSET_NAME.test(name) ? read(`assets/${name}`) : null),
});

export const fileWebAssets = (dir: string): WebAssets =>
  webAssetsFrom(async (relativePath) => {
    try {
      return await readFile(join(dir, relativePath));
    } catch {
      return null;
    }
  });
