import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { BUDGETS, compare, measure } from './check-bundle-budget.mjs';

const script = path.join(import.meta.dirname, 'check-bundle-budget.mjs');

/** A synthetic `dist` with one entry script, one entry style and one lazy chunk. */
const syntheticDist = (t, lazyBytes = 10) => {
  const dist = mkdtempSync(path.join(tmpdir(), 'sipges-bundle-'));
  t.after(() => rmSync(dist, { recursive: true, force: true }));
  mkdirSync(path.join(dist, 'assets'));
  mkdirSync(path.join(dist, 'cesium'));
  writeFileSync(
    path.join(dist, 'index.html'),
    '<script type="module" src="/assets/index-a.js"></script><link rel="stylesheet" href="/assets/index-b.css">',
  );
  writeFileSync(path.join(dist, 'assets/index-a.js'), 'x'.repeat(100));
  writeFileSync(path.join(dist, 'assets/index-b.css'), 'y'.repeat(40));
  writeFileSync(path.join(dist, 'assets/lazy-c.js'), 'z'.repeat(lazyBytes));
  writeFileSync(path.join(dist, 'assets/logo.svg'), 's'.repeat(5000));
  writeFileSync(path.join(dist, 'cesium/Workers.js'), 'w'.repeat(5000));
  return dist;
};

test('a total at its budget passes and one byte over fails, naming the total and the budget', () => {
  const budgets = { 'all CSS, gzip': 47_000 };
  assert.deepEqual(compare({ 'all CSS, gzip': 47_000 }, budgets), []);
  assert.deepEqual(compare({ 'all CSS, gzip': 47_001 }, budgets), [
    'all CSS, gzip: 47.0 kB is over its budget of 47.0 kB by 0.0 kB',
  ]);
  assert.deepEqual(compare({ 'all CSS, gzip': 52_500 }, budgets), [
    'all CSS, gzip: 52.5 kB is over its budget of 47.0 kB by 5.5 kB',
  ]);
});

test('a budget with no measured total fails instead of passing silently', () => {
  assert.deepEqual(compare({}, { 'all JavaScript, gzip': 1_000 }), [
    'all JavaScript, gzip: not measured (budget 1.0 kB)',
  ]);
});

test('measure counts the index.html entry and every emitted script and style, nothing else', (t) => {
  const { totals, raw } = measure(syntheticDist(t));
  assert.equal(totals['entry (index.html scripts and styles), raw'], 140);
  assert.deepEqual(raw, { js: 110, css: 40 });
  assert.ok(totals['all JavaScript, gzip'] > 0 && totals['all CSS, gzip'] > 0);
  assert.deepEqual(Object.keys(totals).sort(), Object.keys(BUDGETS).sort());
});

test('the command exits 0 within budget and 1 with a clear message when a total is crossed', (t) => {
  const small = spawnSync(process.execPath, [script, syntheticDist(t)], { encoding: 'utf8' });
  assert.equal(small.status, 0, small.stderr);
  assert.equal(small.stderr, '');
  // Random bytes do not compress, so the lazy chunk alone crosses the all-JavaScript gzip budget.
  const big = syntheticDist(t, 0);
  writeFileSync(
    path.join(big, 'assets/lazy-c.js'),
    randomBytes(BUDGETS['all JavaScript, gzip'] + 1_000),
  );
  const crossed = spawnSync(process.execPath, [script, big], { encoding: 'utf8' });
  assert.equal(crossed.status, 1);
  assert.match(crossed.stderr, /Bundle budget crossed/);
  assert.match(crossed.stderr, /all JavaScript, gzip: [\d.]+ kB is over its budget of 2080\.0 kB/);
  assert.match(crossed.stderr, /Largest files \(gzip\): lazy-c\.js/);
});

test('CI checks the budget right after the static job builds the web app', () => {
  const ci = readFileSync(path.join(import.meta.dirname, '../.github/workflows/ci.yml'), 'utf8');
  assert.match(
    ci,
    /run: pnpm --filter @sipges\/web build\n(?: +#.*\n)* +- if: .*\n +run: node scripts\/check-bundle-budget\.mjs apps\/web\/dist\n/,
  );
});
