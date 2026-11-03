import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CONTEXT_NAMES } from './contexts/index.ts';
import { loadContexts } from './discover.ts';

test('every context file in src/contexts is discovered without editing index.ts', () => {
  for (const name of [
    'audit',
    'indicators',
    'management',
    'prevention',
    'reference',
    'situations',
  ]) {
    assert.ok(CONTEXT_NAMES.includes(name), `${name} missing from ${CONTEXT_NAMES.join(', ')}`);
  }
  assert.deepEqual([...CONTEXT_NAMES], [...CONTEXT_NAMES].sort());
});

test('a new file is picked up, index.ts and tests are skipped, a module without cases fails', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'parity-contexts-'));
  try {
    writeFileSync(join(dir, 'index.ts'), 'export const cases = [1];');
    writeFileSync(join(dir, 'beta.test.ts'), 'export const cases = [2];');
    writeFileSync(join(dir, 'beta.ts'), "export const cases = []; export const seed = 'SELECT 1';");
    writeFileSync(join(dir, 'alpha.ts'), 'export const cases = [];');
    const found = await loadContexts(dir);
    assert.deepEqual(
      found.map((c) => [c.name, c.seed]),
      [
        ['alpha', ''],
        ['beta', 'SELECT 1'],
      ],
    );

    writeFileSync(join(dir, 'gamma.ts'), 'export const seed = "";');
    await assert.rejects(loadContexts(dir), /gamma\.ts must export `cases`/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
