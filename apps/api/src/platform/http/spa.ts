import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import type { MiddlewareHandler } from 'hono';

/** File contents: whole bytes, or a stream a host passes through without buffering. */
export type AssetBody = Uint8Array | ReadableStream<Uint8Array>;

/** Content codings the web build writes beside each compressible asset (`.br`, `.gz`). */
export type AssetEncoding = 'br' | 'gzip';

/** Built single-page app (apps/web/dist): its HTML shell and its hashed assets. */
export type WebAssets = {
  index(): Promise<string | null>;
  asset(name: string): Promise<AssetBody | null>;
  /**
   * The precompressed variant of an asset, already encoded. Only hosts that send it as is
   * implement it (the Node server); a host that compresses on its own (Cloudflare) leaves it out.
   */
  encodedAsset?(name: string, encoding: AssetEncoding): Promise<AssetBody | null>;
  /** One of ROOT_FILES from the build root (Vite's `public/` directory). */
  rootFile?(name: string): Promise<AssetBody | null>;
  /** A CesiumJS worker or asset under `cesium/` (ADR 0026); `path` is already validated. */
  cesium?(path: string): Promise<AssetBody | null>;
};

const responseBody = (body: AssetBody) =>
  body instanceof Uint8Array ? new Uint8Array(body) : body;

/**
 * Files that must live at the site root and need no session: the installable-app files
 * (docs/adr/0014), the tab icons browsers ask for on the sign-in screen, and the crawler rule
 * (functional-10 T9). Every other path outside the shell and the built folders asks for a session.
 */
const ROOT_FILES: Readonly<Record<string, string>> = {
  '/manifest.webmanifest': 'application/manifest+json',
  '/sw.js': 'text/javascript; charset=utf-8',
  '/icon.svg': 'image/svg+xml',
  '/favicon.ico': 'image/x-icon',
  '/favicon.svg': 'image/svg+xml',
  '/robots.txt': 'text/plain; charset=utf-8',
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

/** Asset types the build precompresses; images and fonts are compressed already. */
const COMPRESSIBLE = new Set(['.js', '.css', '.svg', '.json']);
const VARIANT_SUFFIX: Readonly<Record<AssetEncoding, string>> = { br: '.br', gzip: '.gz' };

/**
 * The precompressed codings an Accept-Encoding header allows, best first: a coding listed with
 * q=0 is refused, `*` stands for the ones not listed, and brotli wins a tie (RFC 9110 §12.5.3).
 */
export const acceptedEncodings = (header: string | undefined | null): AssetEncoding[] => {
  const weights = new Map<string, number>();
  for (const part of (header ?? '').toLowerCase().split(',')) {
    const [coding = '', ...params] = part.split(';').map((piece) => piece.trim());
    if (!coding) continue;
    const q = params.find((param) => param.startsWith('q='));
    const weight = q === undefined ? 1 : Number(q.slice(2));
    weights.set(coding === 'x-gzip' ? 'gzip' : coding, Number.isFinite(weight) ? weight : 0);
  }
  const weightOf = (coding: AssetEncoding) => weights.get(coding) ?? weights.get('*') ?? 0;
  return (['br', 'gzip'] as const)
    .filter((coding) => weightOf(coding) > 0)
    .sort((a, b) => weightOf(b) - weightOf(a));
};

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
const API_PATHS = new Set(['/health', '/health/ready', '/select-project', '/logout']);

const isClientRoute = (path: string) =>
  !API_PATHS.has(path) && !API_PREFIXES.some((prefix) => path.startsWith(prefix));

/**
 * Whether spaMiddleware answers this request itself: built files, and the shell for a browser
 * navigation to a client route. None of them needs a session or the database, so a host may
 * serve them before building the API (the Cloudflare Worker does).
 */
export const isSpaRequest = (method: string, path: string, accept: string | undefined | null) =>
  (method === 'GET' || method === 'HEAD') &&
  (Object.hasOwn(ROOT_FILES, path) ||
    path.startsWith('/assets/') ||
    path.startsWith('/cesium/') ||
    (isClientRoute(path) && (accept ?? '').includes('text/html')));

/**
 * Serves the SPA before authentication: the shell and bundle hold no tenant data, and the app
 * itself asks the API who is signed in. Only isSpaRequest() requests are handled.
 */
export const spaMiddleware =
  (web: WebAssets): MiddlewareHandler =>
  async (c, next) => {
    const path = c.req.path;
    if (!isSpaRequest(c.req.method, path, c.req.header('accept'))) return next();
    const rootType = Object.hasOwn(ROOT_FILES, path) ? ROOT_FILES[path] : undefined;
    if (rootType) {
      const bytes = web.rootFile ? await web.rootFile(path.slice(1)) : null;
      if (!bytes) return c.json({ detail: 'Not Found' }, 404);
      // The worker runs under its own CSP: the SPA policy lets it show the app icon.
      return c.body(responseBody(bytes), 200, {
        'Content-Type': rootType,
        'Content-Security-Policy': SPA_CSP,
      });
    }
    if (path.startsWith('/assets/')) {
      const name = path.slice('/assets/'.length);
      const type = ASSET_TYPES[extname(name)];
      if (!type || !ASSET_NAME.test(name)) return c.json({ detail: 'Not Found' }, 404);
      // Brotli or gzip written at build time, when the client takes it (functional-10 T9).
      const negotiated = web.encodedAsset !== undefined && COMPRESSIBLE.has(extname(name));
      const vary: Record<string, string> = negotiated ? { Vary: 'Accept-Encoding' } : {};
      if (negotiated)
        for (const encoding of acceptedEncodings(c.req.header('accept-encoding'))) {
          const encoded = await web.encodedAsset?.(name, encoding);
          if (encoded)
            return c.body(responseBody(encoded), 200, {
              'Content-Type': type,
              'Cache-Control': ASSET_CACHE,
              'Content-Encoding': encoding,
              ...vary,
            });
        }
      const bytes = await web.asset(name);
      if (!bytes) return c.json({ detail: 'Not Found' }, 404);
      return c.body(responseBody(bytes), 200, {
        'Content-Type': type,
        'Cache-Control': ASSET_CACHE,
        ...vary,
      });
    }
    if (path.startsWith('/cesium/')) {
      const file = path.slice('/cesium/'.length);
      const type = CESIUM_TYPES[extname(file)];
      const bytes = type && CESIUM_PATH.test(file) && web.cesium ? await web.cesium(file) : null;
      if (!type || !bytes) return c.json({ detail: 'Not Found' }, 404);
      return c.body(responseBody(bytes), 200, {
        'Content-Type': type,
        'Cache-Control': CESIUM_CACHE,
        // Workers run under their own response's policy: the SPA one, not the API's.
        'Content-Security-Policy': SPA_CSP,
      });
    }
    const html = await web.index();
    if (html === null) return next();
    c.header('Content-Security-Policy', SPA_CSP);
    c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    return c.html(html);
  };

/**
 * WebAssets over any file source. Every name is validated here, before `read` sees it, so no
 * host adapter can serve a path outside the built app.
 */
export const webAssetsFrom = (
  read: (relativePath: string) => Promise<AssetBody | null>,
): WebAssets => ({
  async index() {
    const body = await read('index.html');
    const bytes =
      body instanceof ReadableStream
        ? new Uint8Array(await new Response(body).arrayBuffer())
        : body;
    // ignoreBOM keeps a leading BOM, exactly as readFile(..., 'utf8') did.
    return bytes ? new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes) : null;
  },
  rootFile: async (name) => (Object.hasOwn(ROOT_FILES, `/${name}`) ? read(name) : null),
  cesium: async (path) => (CESIUM_PATH.test(path) ? read(`cesium/${path}`) : null),
  asset: async (name) => (ASSET_NAME.test(name) ? read(`assets/${name}`) : null),
});

/**
 * Reads a Vite build directory; asset names are validated before they reach the path. The Node
 * server sends the build's `.br` and `.gz` variants as they are, so it offers them.
 */
export const fileWebAssets = (dir: string): WebAssets => {
  const read = async (relativePath: string) => {
    try {
      return await readFile(join(dir, relativePath));
    } catch {
      return null;
    }
  };
  return {
    ...webAssetsFrom(read),
    encodedAsset: async (name, encoding) =>
      ASSET_NAME.test(name) && COMPRESSIBLE.has(extname(name))
        ? read(`assets/${name}${VARIANT_SUFFIX[encoding]}`)
        : null,
  };
};
