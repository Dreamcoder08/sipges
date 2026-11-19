import { createReadStream } from 'node:fs';
import { cp, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, extname, join, resolve, sep } from 'node:path';
import babel from '@rolldown/plugin-babel';
import react, { reactCompilerPreset } from '@vitejs/plugin-react';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';
import { precompress } from './scripts/precompress.ts';
import { trimMaplibreCss } from './scripts/trim-maplibre-css.ts';

/**
 * CesiumJS loads its workers and assets at run time from CESIUM_BASE_URL (ADR 0026). They are
 * copied from @cesium/engine into `dist/cesium/` and served at /cesium/ by the dev server, so
 * the app never reaches another host or Cesium ion for them.
 */
/**
 * The two places where CesiumJS writes inline styles, which the strict `style-src 'self'`
 * refuses: a feature test that sets a style attribute (now set through the CSSOM, which the
 * policy allows) and the credit display's injected <style> element (dropped; its few rules
 * live in GeoCanvas.module.css). A Cesium upgrade that moves either fails the build.
 */
const CSP_PATCHES = [
  {
    file: '@cesium/engine/Source/Core/FeatureDetection.js',
    find: /canvas\.setAttribute\(\s*"style",\s*"image-rendering: -moz-crisp-edges;"\s*\+\s*"image-rendering: pixelated;",?\s*\);/,
    replace: 'canvas.style.imageRendering = "pixelated";',
  },
  {
    file: '@cesium/engine/Source/Scene/CreditDisplay.js',
    find: /shadowRootOrDocumentHead\.appendChild\(styleElem\);/,
    replace: '',
  },
];

/** Drops the stylesheet rules of MapLibre controls GeoCanvas never adds (scripts/trim-maplibre-css.ts). */
const maplibreCss = (): Plugin => ({
  name: 'sipges-trim-maplibre-css',
  enforce: 'pre',
  transform(code, id) {
    if (!(id.split('?')[0] ?? '').endsWith('/maplibre-gl/dist/maplibre-gl.css')) return null;
    return { code: trimMaplibreCss(code), map: null };
  },
});

const cesiumStatic = (): Plugin => {
  const engine = dirname(createRequire(import.meta.url).resolve('@cesium/engine'));
  const dirs: Record<string, string> = {
    Workers: join(engine, 'Build', 'Workers'),
    ThirdParty: join(engine, 'Build', 'ThirdParty'),
    Assets: join(engine, 'Source', 'Assets'),
  };
  const types: Record<string, string> = {
    '.js': 'text/javascript',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.xml': 'application/xml',
  };
  let outDir = 'dist';
  return {
    name: 'sipges-cesium-static',
    transform(code, id) {
      const patch = CSP_PATCHES.find((p) => id.replaceAll('\\', '/').endsWith(p.file));
      if (!patch) return null;
      if (!patch.find.test(code))
        throw new Error(`CesiumJS changed ${patch.file}; review its CSP patch (ADR 0026).`);
      return code.replace(patch.find, patch.replace);
    },
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    configureServer(server) {
      server.middlewares.use('/cesium', (req, res, next) => {
        const [top = '', ...rest] = (req.url ?? '').split('?')[0]?.split('/').filter(Boolean) ?? [];
        const base = dirs[top];
        const file = base ? resolve(base, ...rest) : '';
        const type = types[extname(file)];
        if (!base || !type || !file.startsWith(base + sep)) return next();
        stat(file).then(
          () => {
            res.setHeader('Content-Type', type);
            createReadStream(file).pipe(res);
          },
          () => next(),
        );
      });
    },
    async writeBundle() {
      for (const [name, from] of Object.entries(dirs))
        await cp(from, join(outDir, 'cesium', name), { recursive: true });
    },
  };
};

export default defineConfig({
  plugins: [
    react(),
    // React Compiler v1 (stable, Babel), only on functions marked 'use memo': compiling every
    // component crosses the entry bundle budget (docs/benchmarks/react-compiler-trial.md).
    babel({ presets: [reactCompilerPreset({ compilationMode: 'annotation' })] }),
    maplibreCss(),
    cesiumStatic(),
    // precompress writes brotli and gzip variants of the hashed assets for the servers (F26).
    precompress(),
  ],
  // Pre-bundling would skip the CSP patches above in development.
  optimizeDeps: { exclude: ['@cesium/engine'] },
  resolve: {
    // Keep setup hooks and the runner on one pnpm peer instance, as in the API.
    dedupe: ['vitest'],
    alias: {
      // CesiumJS's only use of it is never reached; the real module compiles WebAssembly on
      // import, which the strict CSP forbids (engine/meshopt-stub.ts).
      meshoptimizer: fileURLToPath(
        new URL('./src/features/geography/engine/meshopt-stub.ts', import.meta.url),
      ),
    },
  },
  build: {
    rolldownOptions: {
      output: {
        // Every module index.html loads at start goes into the entry chunk. Without this group
        // rolldown splits the modules the entry shares with lazy routes (zod, React, shared UI)
        // into common chunks the entry preloads anyway, which costs 1.5 kB gzip and three
        // requests (chat-first-ui T20). Lazy chunks import those modules from the entry.
        codeSplitting: { groups: [{ name: 'app', tags: ['$initial'] }] },
      },
    },
  },
  // MapLibre's worker is an ES module served from our origin (ADR 0017), not a blob: URL.
  worker: { format: 'es' },
  server: {
    port: 5173,
    proxy: {
      // The API owns sessions and cookies; the SPA always talks to it same-origin.
      '/api': 'http://127.0.0.1:8000',
      '/system': 'http://127.0.0.1:8000',
      '/health': 'http://127.0.0.1:8000',
      // GET /login is the SPA's sign-in screen; only the form POST goes to the API.
      '/login': {
        target: 'http://127.0.0.1:8000',
        bypass: (req) => (req.method === 'GET' ? '/index.html' : undefined),
      },
      '/logout': 'http://127.0.0.1:8000',
      '/select-project': 'http://127.0.0.1:8000',
    },
  },
  test: {
    // Serial shell commands alone do not bound concurrent jsdom workers or lazy route loads.
    maxWorkers: 1,
    fileParallelism: false,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
  },
});
