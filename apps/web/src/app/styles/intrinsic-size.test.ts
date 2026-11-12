/// <reference types="node" />
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A max-height transition fakes an animation to the content height and lags when the content is
 * shorter than the cap. Where a sheet still transitions max-height it is only the fallback of an
 * `interpolate-size: allow-keywords` block (modern-web-guidance animate-to-intrinsic-sizes).
 */
// Vitest runs from the package directory (`pnpm --filter @sipges/web test`).
const SRC = join(process.cwd(), 'src/');
const sheets = readdirSync(SRC, { recursive: true, encoding: 'utf8' })
  .filter((path) => path.endsWith('.css'))
  .map((path) => [path.replaceAll('\\', '/'), readFileSync(`${SRC}${path}`, 'utf8')] as const);

describe('intrinsic size animation', () => {
  it('transitions max-height only as the fallback of interpolate-size', () => {
    const offenders = sheets
      .filter(([, css]) => /transition[^;]*max-height/.test(css))
      .filter(([, css]) => !/@supports \(interpolate-size: allow-keywords\)/.test(css))
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });

  it('animates the territorial map sheet height between the peek and its content', () => {
    const css = sheets.find(([path]) => path.endsWith('TerritorialMap.module.css'))?.[1] ?? '';
    const start = css.indexOf('@supports (interpolate-size: allow-keywords)');
    const modern = start < 0 ? '' : css.slice(start);
    expect(modern).toMatch(/\.mapSheet \{[^}]*interpolate-size: allow-keywords;/);
    expect(modern).toMatch(/\.mapSheet \{[^}]*transition: block-size /);
    expect(modern).toMatch(/\.mapSheet\[data-open='false'\] \{[^}]*block-size: 6\.5rem;/);
  });
});
