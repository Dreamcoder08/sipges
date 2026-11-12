import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../src/platform/config.ts';
import { TEST_ENV, createTestApp } from '../support/test-app.ts';
import {
  assertGuardInstalled,
  isLegacyDataPath,
  legacyReads,
  resetLegacyGuard,
} from '../reference/legacy-read-guard.ts';

// Composing the API wires the reference reader: keep every repository `data/` read blocked (L12).
vi.mock('node:fs/promises', async (importOriginal) =>
  (await import('../reference/legacy-read-guard.ts')).guardFsPromises(await importOriginal()),
);
vi.mock('node:fs', async (importOriginal) =>
  (await import('../reference/legacy-read-guard.ts')).guardFs(await importOriginal()),
);
assertGuardInstalled(readFile, readFileSync);

const SCOPE = 'SIPGES/PRJ-SECHURA';
const PATH = '/system/desktop/update';
const temps: string[] = [];

afterEach(async () => {
  expect(legacyReads.passedThrough.filter(isLegacyDataPath)).toEqual([]);
  resetLegacyGuard();
  for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** The channel folder the desktop launcher shares with the API; synthetic versions only. */
const channel = async (available: { version: string; notes: string | null } | null) => {
  const dir = await mkdtemp(join(tmpdir(), 'sipges-desktop-channel-'));
  temps.push(dir);
  await writeFile(
    join(dir, 'status.json'),
    JSON.stringify({ format: 1, installed: '1.0.0', available, checkedAt: '2026-11-11T00:00:00Z' }),
  );
  return dir;
};

const NOTES = 'Corrige el filtro de registros.\nNuevo resumen semanal.';

const setup = async (dir: string | undefined) => {
  const t = await createTestApp(dir === undefined ? {} : { SIPGES_DESKTOP_UPDATE_DIR: dir });
  const admin = await t.login('admin', 'admin-password-123');
  const call = (method: string, path: string, cookie = admin.cookie) =>
    t.request(path, { method, headers: { cookie, 'x-sipges-scope': SCOPE } });
  return { ...t, admin, call };
};

const requested = async (dir: string) => (await readdir(dir)).filter((n) => n !== 'status.json');

describe('desktop update status (rule 1: notice only for a verified newer version)', () => {
  it('reports the newer version and its notes that the launcher verified', async () => {
    const t = await setup(await channel({ version: '1.1.0', notes: NOTES }));
    const res = await t.call('GET', PATH);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      installed: '1.0.0',
      available: '1.1.0',
      notes: NOTES,
      dismissed: false,
    });
  });

  it('reports nothing available when the launcher found no newer signed release', async () => {
    const t = await setup(await channel(null));
    expect(await (await t.call('GET', PATH)).json()).toEqual({
      installed: '1.0.0',
      available: null,
      notes: null,
      dismissed: false,
    });
  });

  it('starts nothing when the launcher found no newer signed release', async () => {
    const dir = await channel(null);
    const t = await setup(dir);
    const res = await t.call('POST', PATH);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ detail: 'No hay una actualización disponible' });
    expect(await requested(dir)).toEqual([]);
  });
});

describe('declining (rule 2)', () => {
  it('hides the notice until the next start and asks the launcher for nothing', async () => {
    const dir = await channel({ version: '1.1.0', notes: null });
    const t = await setup(dir);
    expect((await t.call('POST', `${PATH}/dismiss`)).status).toBe(204);
    expect(await (await t.call('GET', PATH)).json()).toMatchObject({
      available: '1.1.0',
      dismissed: true,
    });
    expect(await requested(dir)).toEqual([]);
    // The next start builds a new API process: the notice comes back.
    const next = await setup(dir);
    expect(await (await next.call('GET', PATH)).json()).toMatchObject({ dismissed: false });
  });
});

describe('starting an update after the click', () => {
  it('asks the launcher for exactly the verified version and says SIPGES restarts', async () => {
    const dir = await channel({ version: '1.1.0', notes: null });
    const t = await setup(dir);
    const res = await t.call('POST', PATH);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ status: 'restarting', version: '1.1.0' });
    expect(await requested(dir)).toEqual(['request.json']);
    expect(JSON.parse(await readFile(join(dir, 'request.json'), 'utf8'))).toMatchObject({
      format: 1,
      version: '1.1.0',
    });
  });
});

describe('cloud and development configuration (rule 3)', () => {
  it('has no desktop update routes without SIPGES_DESKTOP_UPDATE_DIR', async () => {
    const t = await setup(undefined);
    for (const [method, path] of [
      ['GET', PATH],
      ['POST', PATH],
      ['POST', `${PATH}/dismiss`],
    ] as const) {
      const res = await t.call(method, path);
      expect(res.status, `${method} ${path}`).toBe(404);
      expect(await res.json()).toEqual({ detail: 'Not Found' });
    }
  });

  it('accepts only an absolute channel folder', () => {
    expect(loadConfig(TEST_ENV).desktopUpdateDir).toBeUndefined();
    expect(() => loadConfig({ ...TEST_ENV, SIPGES_DESKTOP_UPDATE_DIR: 'relative/dir' })).toThrow(
      'SIPGES_DESKTOP_UPDATE_DIR must be an absolute path',
    );
  });
});

describe('authority (rule 4)', () => {
  it('refuses every role but admin and leaves no request', async () => {
    const dir = await channel({ version: '1.1.0', notes: null });
    const t = await setup(dir);
    for (const role of ['analista', 'coordinador', 'consulta']) {
      expect(
        (
          await t.createAccount(t.admin.cookie, {
            username: role,
            full_name: role,
            password: `${role}-password-123`,
            role,
          })
        ).status,
      ).toBe(200);
      await t.grant(t.admin.cookie, role);
      const { cookie } = await t.login(role, `${role}-password-123`);
      for (const [method, path] of [
        ['GET', PATH],
        ['POST', PATH],
        ['POST', `${PATH}/dismiss`],
      ] as const) {
        const res = await t.call(method, path, cookie);
        expect(res.status, `${role} ${method} ${path}`).toBe(403);
        // Writes by consulta and coordinador already stop at the shared role gate, with its words.
        const detail = ((await res.json()) as { detail: string }).detail;
        if (method === 'GET' || role === 'analista')
          expect(detail).toBe('Requiere rol administrador');
        else expect(detail).toMatch(/^(Rol de consulta|Operación restringida)/);
      }
    }
    expect(await requested(dir)).toEqual([]);
    expect(await (await t.call('GET', PATH)).json()).toMatchObject({ dismissed: false });
  });

  it('asks for a session first', async () => {
    const dir = await channel({ version: '1.1.0', notes: null });
    const t = await setup(dir);
    for (const method of ['GET', 'POST']) {
      const res = await t.call(method, PATH, '');
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ detail: 'Inicie sesión para acceder a SIPGES' });
    }
    expect(await requested(dir)).toEqual([]);
  });
});

describe('a failed or unfinished check (rule 6)', () => {
  it('reports nothing available when the launcher has not written a valid status', async () => {
    const dir = await channel(null);
    await rm(join(dir, 'status.json'));
    const t = await setup(dir);
    expect(await (await t.call('GET', PATH)).json()).toEqual({
      installed: null,
      available: null,
      notes: null,
      dismissed: false,
    });
    await writeFile(join(dir, 'status.json'), '{"format":1,"installed":');
    expect(await (await t.call('GET', PATH)).json()).toMatchObject({ available: null });
    expect((await t.call('POST', PATH)).status).toBe(409);
    expect(await requested(dir)).toEqual([]);
  });
});
