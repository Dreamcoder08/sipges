import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestApp } from '../support/test-app.ts';
import {
  assertGuardInstalled,
  isLegacyDataPath,
  legacyReads,
  resetLegacyGuard,
} from '../reference/legacy-read-guard.ts';

vi.mock('node:fs/promises', async (importOriginal) =>
  (await import('../reference/legacy-read-guard.ts')).guardFsPromises(await importOriginal()),
);
vi.mock('node:fs', async (importOriginal) =>
  (await import('../reference/legacy-read-guard.ts')).guardFs(await importOriginal()),
);
assertGuardInstalled(readFile, readFileSync);

// Boundaries of the desktop update routes found by the independent verification (T4/T9):
// cloud invisibility, cross-site POSTs, server-chosen version and malformed launcher status.
const SCOPE = 'SIPGES/PRJ-SECHURA';
const PATH = '/system/desktop/update';
const temps: string[] = [];
afterEach(async () => {
  expect(legacyReads.passedThrough.filter(isLegacyDataPath)).toEqual([]);
  resetLegacyGuard();
  for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true });
});
const channel = async (status: unknown) => {
  const dir = await mkdtemp(join(tmpdir(), 'sipges-desktop-boundary-'));
  temps.push(dir);
  await writeFile(
    join(dir, 'status.json'),
    typeof status === 'string' ? status : JSON.stringify(status),
  );
  return dir;
};
const ok = { format: 1, installed: '1.0.0', available: { version: '1.1.0', notes: null } };
const setup = async (dir: string | undefined) => {
  const t = await createTestApp(dir === undefined ? {} : { SIPGES_DESKTOP_UPDATE_DIR: dir });
  const admin = await t.login('admin', 'admin-password-123');
  return { ...t, admin };
};
const requested = async (dir: string) => (await readdir(dir)).filter((n) => n !== 'status.json');

describe('desktop update routes: boundaries', () => {
  it('cloud config: 404 with a session; without a session the answer never reveals the route', async () => {
    const t = await setup(undefined);
    for (const [method, path] of [
      ['GET', PATH],
      ['POST', PATH],
      ['POST', `${PATH}/dismiss`],
    ] as const) {
      const withSession = await t.request(path, {
        method,
        headers: { cookie: t.admin.cookie, 'x-sipges-scope': SCOPE },
      });
      expect(withSession.status, `${method} ${path}`).toBe(404);
      const anonymous = await t.request(path, { method, headers: { 'x-sipges-scope': SCOPE } });
      expect([401, 404], `${method} ${path} anonymous`).toContain(anonymous.status);
    }
  });

  it('a cross-site or origin-less POST by a signed-in admin is refused and leaves no request (CSRF)', async () => {
    const dir = await channel(ok);
    const t = await setup(dir);
    for (const origin of ['https://evil.example', '', 'null']) {
      for (const path of [PATH, `${PATH}/dismiss`]) {
        const res = await t.request(path, {
          method: 'POST',
          headers: { cookie: t.admin.cookie, 'x-sipges-scope': SCOPE, origin },
        });
        expect(res.status, `origin=${origin} ${path}`).toBe(403);
      }
    }
    expect(await requested(dir)).toEqual([]);
    const status = await (
      await t.request(PATH, { headers: { cookie: t.admin.cookie, 'x-sipges-scope': SCOPE } })
    ).json();
    expect(status).toMatchObject({ dismissed: false });
  });

  it('the client cannot choose the version: a body naming another version is ignored', async () => {
    const dir = await channel(ok);
    const t = await setup(dir);
    const res = await t.request(PATH, {
      method: 'POST',
      headers: {
        cookie: t.admin.cookie,
        'x-sipges-scope': SCOPE,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ version: '9.9.9', release: '/tmp/evil' }),
    });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ status: 'restarting', version: '1.1.0' });
    const body = JSON.parse(await readFile(join(dir, 'request.json'), 'utf8'));
    expect(body.version).toBe('1.1.0');
    expect(Object.keys(body).sort()).toEqual(['format', 'requestedAt', 'version']);
    expect((await requested(dir)).sort()).toEqual(['request.json']);
  });

  it('a status the launcher did not write in the expected shape offers nothing', async () => {
    for (const status of [
      { ...ok, format: 2 },
      { ...ok, available: { version: '', notes: null } },
      { ...ok, available: { version: 'x'.repeat(300), notes: null } },
      { ...ok, available: { version: '1.1.0', notes: 'n'.repeat(4001) } },
      { ...ok, available: '1.1.0' },
      [ok],
      'null',
      '',
    ]) {
      const dir = await channel(status);
      const t = await setup(dir);
      const res = await t.request(PATH, {
        headers: { cookie: t.admin.cookie, 'x-sipges-scope': SCOPE },
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ available: null, notes: null });
      const post = await t.request(PATH, {
        method: 'POST',
        headers: { cookie: t.admin.cookie, 'x-sipges-scope': SCOPE },
      });
      expect(post.status).toBe(409);
      expect(await requested(dir)).toEqual([]);
    }
  });

  it('unauthenticated dismiss is 401 and does not dismiss', async () => {
    const dir = await channel(ok);
    const t = await setup(dir);
    const res = await t.request(`${PATH}/dismiss`, {
      method: 'POST',
      headers: { 'x-sipges-scope': SCOPE },
    });
    expect(res.status).toBe(401);
    const status = await (
      await t.request(PATH, { headers: { cookie: t.admin.cookie, 'x-sipges-scope': SCOPE } })
    ).json();
    expect(status).toMatchObject({ dismissed: false, available: '1.1.0' });
  });
});
