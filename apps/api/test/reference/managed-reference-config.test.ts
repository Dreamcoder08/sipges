import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { expect, it, vi } from 'vitest';
import { loadConfig } from '../../src/platform/config.ts';
import { TEST_ENV } from '../support/test-app.ts';
import { assertGuardInstalled } from './legacy-read-guard.ts';

// Incident L12: every managed-reference test runs with the repository data/ reads blocked.
vi.mock('node:fs/promises', async (importOriginal) =>
  (await import('./legacy-read-guard.ts')).guardFsPromises(await importOriginal()),
);
vi.mock('node:fs', async (importOriginal) =>
  (await import('./legacy-read-guard.ts')).guardFs(await importOriginal()),
);
assertGuardInstalled(readFile, readFileSync);

it('accepts an absolute managed reference directory and preserves the unset default', () => {
  expect(loadConfig(TEST_ENV).referenceDir).toBeUndefined();
  expect(
    loadConfig({ ...TEST_ENV, SIPGES_REFERENCE_DIR: '/synthetic/references' }).referenceDir,
  ).toBe('/synthetic/references');
  expect(() => loadConfig({ ...TEST_ENV, SIPGES_REFERENCE_DIR: 'relative' })).toThrow(
    'SIPGES_REFERENCE_DIR must be an absolute path',
  );
});
