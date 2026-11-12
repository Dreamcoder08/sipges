#!/usr/bin/env node
/**
 * Bundle size budget for the web build (closure-roadmap T32). Run after `pnpm --filter @sipges/web build`:
 *   node scripts/check-bundle-budget.mjs [apps/web/dist]
 * Measures the files Vite emits under dist/assets (dist/cesium is copied static data, not bundled code),
 * raw and gzip, and fails when a total crosses its budget. Update BUDGETS deliberately: see docs/testing/budgets.md.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';

/**
 * Bytes. Set on 2026-11-12 from the build of origin/main ffae5863 plus 5% headroom, rounded up to 1 kB.
 * Measured then: entry 688,760 raw / 206,727 gzip; all JS 7,271,771 / 1,980,039 gzip; all CSS 223,746 / 44,334 gzip.
 */
export const BUDGETS = {
  'entry (index.html scripts and styles), raw': 724_000,
  'entry (index.html scripts and styles), gzip': 218_000,
  'all JavaScript, gzip': 2_080_000,
  'all CSS, gzip': 47_000,
};

const kB = (bytes) => `${(bytes / 1000).toFixed(1)} kB`;

/** Sizes of one built `dist` folder, grouped as BUDGETS names them. */
export const measure = (dist) => {
  const assets = path.join(dist, 'assets');
  const files = readdirSync(assets).filter((name) => /\.(js|css)$/.test(name));
  const size = (name) => {
    const bytes = readFileSync(path.join(assets, name));
    return { raw: bytes.length, gzip: gzipSync(bytes).length };
  };
  const sizes = new Map(files.map((name) => [name, size(name)]));
  const html = readFileSync(path.join(dist, 'index.html'), 'utf8');
  const entry = [...html.matchAll(/(?:src|href)="\/assets\/([^"]+\.(?:js|css))"/g)].map(
    (m) => m[1],
  );
  const sum = (names, key) =>
    names.reduce((total, name) => total + (sizes.get(name)?.[key] ?? 0), 0);
  const js = files.filter((name) => name.endsWith('.js'));
  const css = files.filter((name) => name.endsWith('.css'));
  return {
    files: sizes,
    totals: {
      'entry (index.html scripts and styles), raw': sum(entry, 'raw'),
      'entry (index.html scripts and styles), gzip': sum(entry, 'gzip'),
      'all JavaScript, gzip': sum(js, 'gzip'),
      'all CSS, gzip': sum(css, 'gzip'),
    },
    raw: { js: sum(js, 'raw'), css: sum(css, 'raw') },
  };
};

/** One message per crossed or unmeasured budget; empty when every total fits. */
export const compare = (totals, budgets = BUDGETS) =>
  Object.entries(budgets).flatMap(([name, budget]) => {
    const actual = totals[name];
    if (typeof actual !== 'number') return [`${name}: not measured (budget ${kB(budget)})`];
    if (actual <= budget) return [];
    const over = actual - budget;
    return [`${name}: ${kB(actual)} is over its budget of ${kB(budget)} by ${kB(over)}`];
  });

const main = (dist) => {
  const { files, totals, raw } = measure(dist);
  for (const [name, budget] of Object.entries(BUDGETS))
    console.log(`${name.padEnd(46)} ${kB(totals[name]).padStart(11)} / ${kB(budget)}`);
  console.log(`(raw totals: JavaScript ${kB(raw.js)}, CSS ${kB(raw.css)}; ${files.size} files)`);
  const failures = compare(totals);
  if (failures.length === 0) return 0;
  const largest = [...files].sort((a, b) => b[1].gzip - a[1].gzip).slice(0, 5);
  console.error(
    `\nBundle budget crossed (scripts/check-bundle-budget.mjs):\n- ${failures.join('\n- ')}`,
  );
  console.error(
    `Largest files (gzip): ${largest.map(([n, s]) => `${n} ${kB(s.gzip)}`).join(', ')}`,
  );
  console.error(
    'Shrink the bundle, or raise BUDGETS on purpose as docs/testing/budgets.md explains.',
  );
  return 1;
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href)
  process.exitCode = main(path.resolve(process.argv[2] ?? 'apps/web/dist'));
