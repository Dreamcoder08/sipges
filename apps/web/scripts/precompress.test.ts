import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { precompressAssets } from './precompress.ts';

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** A synthetic build output with the kinds of files Vite emits. */
const build = async (files: Record<string, string | Buffer>) => {
  const dir = await mkdtemp(join(tmpdir(), 'sipges-precompress-'));
  dirs.push(dir);
  await mkdir(join(dir, 'assets'));
  for (const [name, body] of Object.entries(files)) await writeFile(join(dir, name), body);
  return dir;
};

const script = 'export const greeting = "hola";\n'.repeat(200);
const style = '.card { color: red; padding: 1rem; }\n'.repeat(100);

/** functional-10 T9 (F26): brotli and gzip variants of the hashed assets, written at build. */
describe('precompressAssets', () => {
  it('writes .br and .gz beside each script, style, SVG and JSON asset, decoding to the same bytes', async () => {
    const dir = await build({
      'assets/index-abc123.js': script,
      'assets/index-def456.css': style,
      'assets/logo-1a2b3c.svg': `<svg>${'<g/>'.repeat(400)}</svg>`,
      'assets/data-9z8y7x.json': JSON.stringify({ items: Array(300).fill('x') }),
    });
    const written = await precompressAssets(dir, [
      'assets/index-abc123.js',
      'assets/index-def456.css',
      'assets/logo-1a2b3c.svg',
      'assets/data-9z8y7x.json',
    ]);
    expect(written).toEqual([
      'assets/index-abc123.js.br',
      'assets/index-abc123.js.gz',
      'assets/index-def456.css.br',
      'assets/index-def456.css.gz',
      'assets/logo-1a2b3c.svg.br',
      'assets/logo-1a2b3c.svg.gz',
      'assets/data-9z8y7x.json.br',
      'assets/data-9z8y7x.json.gz',
    ]);
    for (const name of ['index-abc123.js', 'index-def456.css']) {
      const original = await readFile(join(dir, 'assets', name));
      const br = await readFile(join(dir, 'assets', `${name}.br`));
      const gz = await readFile(join(dir, 'assets', `${name}.gz`));
      expect(brotliDecompressSync(br).equals(original), name).toBe(true);
      expect(gunzipSync(gz).equals(original), name).toBe(true);
      expect(br.length).toBeLessThan(original.length);
      expect(gz.length).toBeLessThan(original.length);
    }
  });

  it('leaves images, fonts, tiny files and anything outside assets/ alone', async () => {
    const dir = await build({
      'assets/photo-abc.png': Buffer.alloc(4000, 7),
      'assets/font-abc.woff2': Buffer.alloc(4000, 7),
      'assets/tiny-abc.js': 'x()',
      'index.html': `<html>${'<p>hola</p>'.repeat(300)}</html>`,
      'sw.js': script,
    });
    const written = await precompressAssets(dir, [
      'assets/photo-abc.png',
      'assets/font-abc.woff2',
      'assets/tiny-abc.js',
      'index.html',
      'sw.js',
    ]);
    expect(written).toEqual([]);
    for (const name of ['assets/photo-abc.png', 'assets/tiny-abc.js', 'index.html', 'sw.js'])
      for (const suffix of ['.br', '.gz']) expect(existsSync(join(dir, name + suffix))).toBe(false);
  });

  it('overwrites a variant left by an earlier build and never deletes a file', async () => {
    const dir = await build({
      'assets/index-abc123.js': script,
      'assets/index-abc123.js.br': 'stale',
      'assets/index-abc123.js.gz': 'stale',
      'assets/old-chunk.js.br': 'from another build',
    });
    await precompressAssets(dir, ['assets/index-abc123.js']);
    const original = await readFile(join(dir, 'assets/index-abc123.js'));
    expect(
      brotliDecompressSync(await readFile(join(dir, 'assets/index-abc123.js.br'))).equals(original),
    ).toBe(true);
    expect(
      gunzipSync(await readFile(join(dir, 'assets/index-abc123.js.gz'))).equals(original),
    ).toBe(true);
    expect(await readFile(join(dir, 'assets/old-chunk.js.br'), 'utf8')).toBe('from another build');
  });
});
