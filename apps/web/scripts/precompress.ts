import { readFile, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { promisify } from 'node:util';
import { brotliCompress, constants, gzip } from 'node:zlib';
import type { Plugin } from 'vite';

const brotli = promisify(brotliCompress);
const gzipAsync = promisify(gzip);

/** Asset types worth compressing; images and fonts are compressed already. */
const COMPRESSIBLE = new Set(['.js', '.css', '.svg', '.json']);
/** Below this a variant saves less than its own request headers cost. */
const MIN_BYTES = 1024;

/**
 * Writes `<name>.br` and `<name>.gz` beside every compressible file under `assets/` (functional-10
 * T9, F26), for the servers to send to a client that accepts them (apps/api spa.ts, apps/api-go
 * httpx/web.go). A variant is written only when it is smaller than the file; an existing one is
 * overwritten, and nothing is ever deleted. Returns the variants written, in input order.
 */
export const precompressAssets = async (
  outDir: string,
  fileNames: readonly string[],
): Promise<string[]> => {
  const targets = fileNames.filter(
    (name) => name.startsWith('assets/') && COMPRESSIBLE.has(extname(name)),
  );
  const perFile = await Promise.all(
    targets.map(async (name) => {
      const bytes = await readFile(join(outDir, name));
      if (bytes.length < MIN_BYTES) return [];
      const [br, gz] = await Promise.all([
        brotli(bytes, {
          params: {
            [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY,
            [constants.BROTLI_PARAM_MODE]:
              extname(name) === '.svg' || extname(name) === '.json'
                ? constants.BROTLI_MODE_GENERIC
                : constants.BROTLI_MODE_TEXT,
            [constants.BROTLI_PARAM_SIZE_HINT]: bytes.length,
          },
        }),
        gzipAsync(bytes, { level: constants.Z_BEST_COMPRESSION }),
      ]);
      const written: string[] = [];
      for (const [suffix, variant] of [
        ['.br', br],
        ['.gz', gz],
      ] as const) {
        if (variant.length >= bytes.length) continue;
        await writeFile(join(outDir, name + suffix), variant);
        written.push(name + suffix);
      }
      return written;
    }),
  );
  return perFile.flat();
};

/** Runs precompressAssets on the files of each production build, once they are written. */
export const precompress = (): Plugin => ({
  name: 'sipges-precompress',
  apply: 'build',
  writeBundle: {
    order: 'post',
    sequential: true,
    async handler(options, bundle) {
      if (!options.dir) return;
      const written = await precompressAssets(options.dir, Object.keys(bundle));
      this.info(`brotli and gzip variants written: ${written.length}`);
    },
  },
});
