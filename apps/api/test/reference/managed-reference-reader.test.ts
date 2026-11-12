import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createTestApp } from '../support/test-app.ts';
import {
  assertGuardInstalled,
  fakeLegacyFile,
  isLegacyDataPath,
  LEGACY_DATA_DIR,
  legacyReads,
  resetLegacyGuard,
} from './legacy-read-guard.ts';

// Incident L12: a test that falls back to the legacy reader must hit the guard, not data/.
vi.mock('node:fs/promises', async (importOriginal) =>
  (await import('./legacy-read-guard.ts')).guardFsPromises(await importOriginal()),
);
vi.mock('node:fs', async (importOriginal) =>
  (await import('./legacy-read-guard.ts')).guardFs(await importOriginal()),
);
assertGuardInstalled(readFile, readFileSync);

afterEach(() => {
  expect(legacyReads.passedThrough.filter(isLegacyDataPath)).toEqual([]);
  resetLegacyGuard();
});

const ENTITIES_NOTICE =
  'Las denominaciones canónicas no reescriben los textos de las fuentes originales.';
const SERVER_ERROR = { detail: 'Internal Server Error' };

/** Fully synthetic payload that satisfies the ProjectCoordinates contract. */
const syntheticCoordinates = () => {
  const ring = [
    [-80.1, -5.1],
    [-80.0, -5.1],
    [-80.0, -5.0],
    [-80.1, -5.1],
  ];
  return {
    project_id: 'PRJ-SYNTHETIC',
    project_name: 'Synthetic project',
    initiative: 'Synthetic initiative',
    description: 'Synthetic description',
    crs: {
      geometry: 'EPSG:4326',
      label: 'WGS 84',
      projected_reference: 'synthetic',
      axis_order: 'lon,lat',
    },
    source: {
      organization: 'Synthetic org',
      service: 'synthetic service',
      dataset: 'synthetic dataset',
      consulted_on: '2026-01-01',
      scope: 'Synthetic scope notice',
    },
    nominal_area_source: { label: 'synthetic', scope: 'synthetic' },
    bbox: [-80.1, -5.1, -80.0, -5.0],
    summary: { concession_count: 1, nominal_area_total_ha: 10, gis_area_total_ha: 9.5 },
    concessions: [
      {
        code: 'SYN-001',
        name: 'Synthetic concession',
        nominal_area_ha: 10,
        gis_area_ha: 9.5,
        substance: 'synthetic',
        holder: 'Synthetic holder',
        department: 'Synthetic',
        province: 'Synthetic',
        district: 'Synthetic',
        mining_zone: 'Synthetic',
        centroid: { longitude: -80.05, latitude: -5.05, method: 'synthetic' },
        bbox: [-80.1, -5.1, -80.0, -5.0],
        geometry: { type: 'Polygon', coordinates: [ring] },
      },
    ],
  };
};

const syntheticEntities = {
  TEST: {
    canonical_name: 'Synthetic',
    short_name: 'S',
    entity_type: 'test',
    territory: 'test',
    note: 'test',
  },
};

/** A real (symlink-free) temporary root, so ancestor checks see no link from the platform. */
const withRoot = async (run: (root: string) => Promise<void>) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'sipges-reference-')));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

const managedApp = async (dir: string) => {
  const t = await createTestApp({ SIPGES_REFERENCE_DIR: dir });
  const { cookie } = await t.login('admin', 'admin-password-123');
  return {
    entities: () => t.request('/system/canonical-entities', { headers: { cookie } }),
    coordinates: () => t.request('/system/project-coordinates', { headers: { cookie } }),
  };
};

it('isolates managed references through the public routes', async () => {
  await withRoot(async (root) => {
    const dir = join(root, 'references');
    await mkdir(dir);
    const outside = join(root, 'outside');
    await writeFile(
      outside,
      JSON.stringify({
        SECRET: {
          canonical_name: 'outside',
          short_name: '',
          entity_type: '',
          territory: '',
          note: '',
        },
      }),
    );
    const app = await managedApp(dir);
    const missing = await app.entities();
    expect(missing.status).toBe(200);
    expect(await missing.json()).toEqual({ available: false, data: null, notice: ENTITIES_NOTICE });
    const coords = await app.coordinates();
    expect(coords.status).toBe(200);
    expect(await coords.json()).toEqual({
      available: false,
      data: null,
      notice: 'No hay geometría de referencia registrada para este proyecto.',
    });
    const file = join(dir, 'canonical_entities.json');
    await writeFile(file, JSON.stringify(syntheticEntities));
    const valid = await app.entities();
    expect(valid.status).toBe(200);
    expect(await valid.json()).toEqual({
      available: true,
      data: syntheticEntities,
      notice: ENTITIES_NOTICE,
    });
    await writeFile(file, '{bad');
    const corrupt = await app.entities();
    expect(corrupt.status).toBe(500);
    expect(await corrupt.text()).not.toContain('outside');
    await rm(file);
    await symlink(outside, file);
    const linked = await app.entities();
    expect(linked.status).toBe(500);
    expect(await linked.text()).not.toContain('outside');
    // Missing managed files never fall back to the repository datasets.
    expect(legacyReads.attempts).toEqual([]);
  });
});

it('serves a valid managed coordinate payload with its source notice', async () => {
  await withRoot(async (root) => {
    const dir = join(root, 'references');
    await mkdir(dir);
    const payload = syntheticCoordinates();
    await writeFile(join(dir, 'project_coordinates.json'), JSON.stringify(payload));
    const response = await (await managedApp(dir)).coordinates();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      available: true,
      data: payload,
      notice: 'Synthetic scope notice',
    });
    expect(legacyReads.attempts).toEqual([]);
  });
});

it('refuses well-formed JSON that breaks the reference contracts', async () => {
  await withRoot(async (root) => {
    const dir = join(root, 'references');
    await mkdir(dir);
    const withoutCrs: Record<string, unknown> = syntheticCoordinates();
    delete withoutCrs.crs;
    await writeFile(join(dir, 'project_coordinates.json'), JSON.stringify(withoutCrs));
    await writeFile(
      join(dir, 'canonical_entities.json'),
      JSON.stringify({ TEST: { canonical_name: 42 } }),
    );
    const app = await managedApp(dir);
    for (const response of [await app.coordinates(), await app.entities()]) {
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual(SERVER_ERROR);
    }
    expect(legacyReads.attempts).toEqual([]);
  });
});

it('refuses a managed directory reached through a symlink', async () => {
  await withRoot(async (root) => {
    const real = join(root, 'real');
    await mkdir(join(real, 'references'), { recursive: true });
    await writeFile(
      join(real, 'references', 'canonical_entities.json'),
      JSON.stringify(syntheticEntities),
    );
    await symlink(join(real, 'references'), join(root, 'linked'), 'dir');
    await symlink(real, join(root, 'parent-link'), 'dir');
    // The configured directory itself, and one of its ancestors, are links.
    for (const dir of [join(root, 'linked'), join(root, 'parent-link', 'references')]) {
      const response = await (await managedApp(dir)).entities();
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual(SERVER_ERROR);
    }
    expect(legacyReads.attempts).toEqual([]);
  });
});

it('refuses managed reference names that are not regular files', async () => {
  await withRoot(async (root) => {
    const dir = join(root, 'references');
    await mkdir(join(dir, 'canonical_entities.json'), { recursive: true });
    // A FIFO must be refused without blocking the request (POSIX only).
    const fifo = process.platform !== 'win32';
    if (fifo) execFileSync('mkfifo', [join(dir, 'project_coordinates.json')]);
    const app = await managedApp(dir);
    const responses = [await app.entities(), ...(fifo ? [await app.coordinates()] : [])];
    for (const response of responses) {
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual(SERVER_ERROR);
    }
    expect(legacyReads.attempts).toEqual([]);
  });
});

it('keeps the unmanaged repository reader and its tenant rule unchanged', async () => {
  const coordinates = syntheticCoordinates();
  fakeLegacyFile('project_coordinates.json', JSON.stringify(coordinates));
  fakeLegacyFile('canonical_entities.json', JSON.stringify(syntheticEntities));
  const t = await createTestApp();
  const { cookie } = await t.login('admin', 'admin-password-123');
  const coords = await t.request('/system/project-coordinates', { headers: { cookie } });
  expect(coords.status).toBe(200);
  expect(await coords.json()).toEqual({
    available: true,
    data: coordinates,
    notice: 'Synthetic scope notice',
  });
  const entities = await t.request('/system/canonical-entities', { headers: { cookie } });
  expect(await entities.json()).toEqual({
    available: true,
    data: syntheticEntities,
    notice: ENTITIES_NOTICE,
  });
  expect(legacyReads.attempts).toEqual([
    join(LEGACY_DATA_DIR, 'project_coordinates.json'),
    join(LEGACY_DATA_DIR, 'canonical_entities.json'),
  ]);
  await t.createScope(cookie, {
    company_id: 'OTHER',
    project_id: 'PRJ-SECHURA',
    label: 'Other tenant',
    username: 'admin',
  });
  const other = await t.request('/system/canonical-entities', {
    headers: { cookie, 'X-SIPGES-Scope': 'OTHER/PRJ-SECHURA' },
  });
  expect(await other.json()).toEqual({ available: false, data: null, notice: ENTITIES_NOTICE });
  // Another tenant never reaches the files at all.
  expect(legacyReads.attempts).toHaveLength(2);
});
