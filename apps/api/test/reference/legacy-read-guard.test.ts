import { readFileSync } from 'node:fs';
import { open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { fileReferenceReader } from '../../src/contexts/reference/infrastructure/file-reference-reader.ts';
import { createTestApp } from '../support/test-app.ts';
import {
  LEGACY_DATA_DIR,
  LegacyReadBlocked,
  assertGuardInstalled,
  isLegacyDataPath,
  legacyReads,
  outcome,
  resetLegacyGuard,
} from './legacy-read-guard.ts';

// Incident L12: no test in this file may open the repository reference datasets.
vi.mock('node:fs/promises', async (importOriginal) =>
  (await import('./legacy-read-guard.ts')).guardFsPromises(await importOriginal()),
);
vi.mock('node:fs', async (importOriginal) =>
  (await import('./legacy-read-guard.ts')).guardFs(await importOriginal()),
);

assertGuardInstalled(readFile, open, readFileSync);

const SCOPE = { companyId: 'SIPGES', projectId: 'PRJ-SECHURA' };

afterEach(() => {
  // Nothing under data/ ever reached the real filesystem.
  expect(legacyReads.passedThrough.filter(isLegacyDataPath)).toEqual([]);
  resetLegacyGuard();
});

it('refuses the legacy reader before it opens a repository dataset', async () => {
  expect(await outcome(fileReferenceReader.coordinates(SCOPE))).toBe('blocked');
  expect(await outcome(fileReferenceReader.entities(SCOPE))).toBe('blocked');
  expect(legacyReads.attempts).toEqual([
    join(LEGACY_DATA_DIR, 'project_coordinates.json'),
    join(LEGACY_DATA_DIR, 'canonical_entities.json'),
  ]);
});

it('refuses every filesystem entry point that names a path under data/', async () => {
  const seed = join(LEGACY_DATA_DIR, 'seed.json');
  expect(await outcome(readFile(seed))).toBe('blocked');
  expect(await outcome(readFile(new URL(`file://${seed}`)))).toBe('blocked');
  expect(await outcome(open(join(LEGACY_DATA_DIR, 'nested', '..', 'x.db')))).toBe('blocked');
  expect(() => readFileSync(seed)).toThrow(LegacyReadBlocked);
  expect(legacyReads.attempts).toHaveLength(4);
  // A sibling whose name only starts with "data" is not the dataset directory.
  expect(isLegacyDataPath(`${LEGACY_DATA_DIR}-other/file.json`)).toBe(false);
});

it('turns the incident route into a server error that carries no dataset content', async () => {
  const t = await createTestApp();
  const { cookie } = await t.login('admin', 'admin-password-123');
  const response = await t.request('/system/canonical-entities', { headers: { cookie } });
  expect(response.status).toBe(500);
  expect(await response.json()).toEqual({ detail: 'Internal Server Error' });
  expect(legacyReads.attempts).toEqual([join(LEGACY_DATA_DIR, 'canonical_entities.json')]);
});
