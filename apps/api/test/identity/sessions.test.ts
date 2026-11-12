import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sessionTokens } from '../../src/contexts/identity/infrastructure/session-tokens.ts';
import { createTestApp } from '../support/test-app.ts';

// Cuenta: one's own active sessions and «cerrar sesión en todos los demás» (compact-sidebar S7,
// closure-roadmap T17). Everything goes through the public HTTP interface.

type TestApp = Awaited<ReturnType<typeof createTestApp>>;

const ADMIN = { username: 'admin', password: 'admin-password-123' };
const ANALYST = {
  username: 'ana.perez',
  full_name: 'Ana Pérez',
  password: 'analyst-pass-123',
  role: 'analista',
};
const READER = {
  username: 'lector',
  full_name: 'Lector Sintético',
  password: 'reader-pass-1234',
  role: 'consulta',
};
const SESSIONS = '/system/auth/sessions';
const REVOKE_OTHERS = `${SESSIONS}/revoke-others`;

type Session = {
  id: string;
  created_at: string;
  expires_at: string;
  method: 'password' | 'google';
  current: boolean;
};

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/** Admin with two sessions and an analyst with two sessions, one minute apart each. */
const setup = async () => {
  const t = await createTestApp();
  const admin1 = await t.login(ADMIN.username, ADMIN.password);
  t.clock.advance(60);
  const admin2 = await t.login(ADMIN.username, ADMIN.password);
  expect((await t.createAccount(admin1.cookie, ANALYST)).status).toBe(200);
  await t.grant(admin1.cookie, ANALYST.username);
  t.clock.advance(60);
  const ana1 = await t.login(ANALYST.username, ANALYST.password);
  t.clock.advance(60);
  const ana2 = await t.login(ANALYST.username, ANALYST.password);
  return { t, admin1, admin2, ana1, ana2 };
};

const list = async (t: TestApp, cookie: string) => {
  const res = await t.request(SESSIONS, { headers: { cookie } });
  return { res, text: await res.text() };
};

const sessionsOf = async (t: TestApp, cookie: string) => {
  const { res, text } = await list(t, cookie);
  expect(res.status).toBe(200);
  return (JSON.parse(text) as { sessions: Session[] }).sessions;
};

const end = (t: TestApp, cookie: string, id: string, headers: Record<string, string> = {}) =>
  t.request(`${SESSIONS}/${id}`, { method: 'DELETE', headers: { cookie, ...headers } });

const revokeOthers = (t: TestApp, cookie: string, headers: Record<string, string> = {}) =>
  t.request(REVOKE_OTHERS, { method: 'POST', headers: { cookie, ...headers } });

const me = async (t: TestApp, cookie: string) =>
  (await (await t.request('/system/auth/me', { headers: { cookie } })).json()) as {
    username: string;
  } | null;

const sessionAudit = async (t: TestApp, cookie: string) =>
  (
    (await (await t.request('/system/audit', { headers: { cookie } })).json()) as {
      module: string;
      record_id: string | null;
      action: string;
      detail: string | null;
    }[]
  )
    .filter((entry) => entry.module === 'Sesiones')
    .map(({ module, record_id, action, detail }) => ({ module, record_id, action, detail }));

describe('session ids', () => {
  it('are the vector the Go port pins (sessions_test.go)', () => {
    const hash = sessionTokens.hash('0123456789abcdef'.repeat(4));
    expect(hash).toBe('a8ae6e6ee929abea3afcfc5258c8ccd6f85273e0d4626d26c7279f3250f77c8e');
    expect(sessionTokens.publicId(hash)).toBe('d273ad4c4a81cbb4ee407c3c71beef51');
  });
});

describe('GET /system/auth/sessions', () => {
  it("lists only the caller's own sessions, newest first, with this one marked", async () => {
    const { t, admin1, admin2, ana1, ana2 } = await setup();

    const adminSessions = await sessionsOf(t, admin1.cookie);
    expect(adminSessions).toEqual([
      {
        id: expect.stringMatching(/^[0-9a-f]{32}$/),
        created_at: '2026-10-12T12:01:00Z',
        expires_at: '2026-10-12T20:01:00Z',
        method: 'password',
        current: false,
      },
      {
        id: expect.stringMatching(/^[0-9a-f]{32}$/),
        created_at: '2026-10-12T12:00:00Z',
        expires_at: '2026-10-12T20:00:00Z',
        method: 'password',
        current: true,
      },
    ]);

    const anaSessions = await sessionsOf(t, ana2.cookie);
    expect(anaSessions.map((s) => [s.created_at, s.current])).toEqual([
      ['2026-10-12T12:03:00Z', true],
      ['2026-10-12T12:02:00Z', false],
    ]);
    const adminIds = adminSessions.map((s) => s.id);
    expect(anaSessions.some((s) => adminIds.includes(s.id))).toBe(false);

    // The same session keeps the same id whichever own session asks.
    const fromOther = await sessionsOf(t, admin2.cookie);
    expect(fromOther.map((s) => s.id)).toEqual(adminIds);
    expect(fromOther.map((s) => s.current)).toEqual([true, false]);
    expect((await sessionsOf(t, ana1.cookie)).map((s) => s.current)).toEqual([false, true]);
  });

  it('never exposes a token or its stored hash', async () => {
    const { t, admin1, admin2 } = await setup();
    const { text } = await list(t, admin1.cookie);
    for (const token of [admin1.token, admin2.token]) {
      expect(text).not.toContain(token);
      expect(text).not.toContain(sha256(token));
      expect(text).not.toContain(sha256(token).slice(0, 32));
      expect(text).not.toContain(token.slice(0, 32));
    }
  });

  it('leaves out expired sessions and labels Google sign-ins', async () => {
    const { t, admin1, admin2 } = await setup();
    await t.sql.query('UPDATE sessions SET via_google = true WHERE token_hash = $1', [
      sha256(admin2.token),
    ]);
    expect((await sessionsOf(t, admin1.cookie)).map((s) => s.method)).toEqual([
      'google',
      'password',
    ]);
    await t.sql.query(
      "UPDATE sessions SET expires_at = '2026-10-12T00:00:00Z' WHERE token_hash = $1",
      [sha256(admin2.token)],
    );
    expect((await sessionsOf(t, admin1.cookie)).map((s) => s.current)).toEqual([true]);
  });
});

describe('DELETE /system/auth/sessions/:id', () => {
  it('ends another own session: its next request is 401, this one keeps working', async () => {
    const { t, admin1, admin2 } = await setup();
    const other = (await sessionsOf(t, admin1.cookie)).find((s) => !s.current);
    const res = await end(t, admin1.cookie, other?.id ?? '');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, current: false });
    expect(res.headers.get('set-cookie')).toBeNull();

    expect((await list(t, admin2.cookie)).res.status).toBe(401);
    expect(await me(t, admin2.cookie)).toBeNull();
    expect((await sessionsOf(t, admin1.cookie)).map((s) => s.current)).toEqual([true]);
  });

  it("answers 404 for another user's session, which keeps working", async () => {
    const { t, admin1, ana1, ana2 } = await setup();
    const anaIds = (await sessionsOf(t, ana1.cookie)).map((s) => s.id);
    for (const id of anaIds) {
      const res = await end(t, admin1.cookie, id);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ detail: 'Sesión inexistente' });
    }
    expect((await sessionsOf(t, ana1.cookie)).map((s) => s.id)).toEqual(anaIds);
    expect((await me(t, ana2.cookie))?.username).toBe(ANALYST.username);
  });

  it.each([
    ['an unknown id', '0'.repeat(32)],
    ['a malformed id', 'revoke-others'],
    ['an upper-case id', 'A'.repeat(32)],
  ])('answers 404 for %s', async (_case, id) => {
    const { t, admin1 } = await setup();
    const res = await end(t, admin1.cookie, id);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ detail: 'Sesión inexistente' });
    expect(await sessionsOf(t, admin1.cookie)).toHaveLength(2);
  });

  it('accepts neither the token nor its hash as an id', async () => {
    const { t, admin1, admin2 } = await setup();
    for (const id of [admin2.token, sha256(admin2.token)]) {
      expect((await end(t, admin1.cookie, id)).status).toBe(404);
    }
    expect((await me(t, admin2.cookie))?.username).toBe(ADMIN.username);
  });

  it('ending the current session behaves like logout', async () => {
    const { t, admin1, admin2 } = await setup();
    const current = (await sessionsOf(t, admin1.cookie)).find((s) => s.current);
    const res = await end(t, admin1.cookie, current?.id ?? '');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, current: true });
    const cookies = res.headers.getSetCookie();
    expect(cookies.some((c) => c.startsWith('sipges_session=;') && c.includes('Max-Age=0'))).toBe(
      true,
    );
    expect(cookies.some((c) => c.startsWith('sipges_scope=;') && c.includes('Max-Age=0'))).toBe(
      true,
    );
    expect((await list(t, admin1.cookie)).res.status).toBe(401);
    expect((await sessionsOf(t, admin2.cookie)).map((s) => s.current)).toEqual([true]);
  });
});

describe('POST /system/auth/sessions/revoke-others', () => {
  it('ends every other own session, keeps this one and returns the count', async () => {
    const { t, admin1, admin2, ana1, ana2 } = await setup();
    t.clock.advance(60);
    const admin3 = await t.login(ADMIN.username, ADMIN.password);

    const res = await revokeOthers(t, admin2.cookie);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, count: 2 });

    expect((await list(t, admin1.cookie)).res.status).toBe(401);
    expect((await list(t, admin3.cookie)).res.status).toBe(401);
    const left = await sessionsOf(t, admin2.cookie);
    expect(left.map((s) => [s.created_at, s.current])).toEqual([['2026-10-12T12:01:00Z', true]]);

    // Other users are unaffected.
    expect(await sessionsOf(t, ana1.cookie)).toHaveLength(2);
    expect((await me(t, ana2.cookie))?.username).toBe(ANALYST.username);

    const again = await revokeOthers(t, admin2.cookie);
    expect(await again.json()).toEqual({ ok: true, count: 0 });
  });
});

describe('session routes: gates', () => {
  it.each([
    ['GET', SESSIONS],
    ['DELETE', `${SESSIONS}/${'0'.repeat(32)}`],
    ['POST', REVOKE_OTHERS],
  ])('%s %s answers 401 without a session or with an unknown one', async (method, path) => {
    const t = await createTestApp();
    for (const headers of [{}, { cookie: `sipges_session=${'f'.repeat(64)}` }]) {
      const res = await t.request(path, { method, headers });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ detail: 'Inicie sesión para acceder a SIPGES' });
    }
  });

  it.each([
    ['without Origin', { origin: '' }],
    ['with Origin: null', { origin: 'null' }],
    ['from another site', { origin: 'https://evil.example' }],
  ])('refuses writes %s and ends nothing', async (_case, headers) => {
    const { t, admin1, admin2 } = await setup();
    const other = (await sessionsOf(t, admin1.cookie)).find((s) => !s.current);
    const deleted = await end(t, admin1.cookie, other?.id ?? '', headers);
    expect(deleted.status).toBe(403);
    const revoked = await revokeOthers(t, admin1.cookie, headers);
    expect(revoked.status).toBe(403);
    expect((await me(t, admin2.cookie))?.username).toBe(ADMIN.username);
    expect(await sessionsOf(t, admin1.cookie)).toHaveLength(2);
  });

  it('lets a read-only account manage its own sessions', async () => {
    const { t, admin1 } = await setup();
    expect((await t.createAccount(admin1.cookie, READER)).status).toBe(200);
    await t.grant(admin1.cookie, READER.username);
    const first = await t.login(READER.username, READER.password);
    t.clock.advance(60);
    const second = await t.login(READER.username, READER.password);
    t.clock.advance(60);
    const third = await t.login(READER.username, READER.password);

    const oldest = (await sessionsOf(t, third.cookie)).at(-1);
    const ended = await end(t, third.cookie, oldest?.id ?? '');
    expect(ended.status).toBe(200);
    expect(await me(t, first.cookie)).toBeNull();

    const revoked = await revokeOthers(t, third.cookie);
    expect(revoked.status).toBe(200);
    expect(await revoked.json()).toEqual({ ok: true, count: 1 });
    expect(await me(t, second.cookie)).toBeNull();
  });
});

describe('session routes: audit', () => {
  it('records each write in the active project, with no secret material', async () => {
    const { t, admin1, admin2 } = await setup();
    t.clock.advance(60);
    const admin3 = await t.login(ADMIN.username, ADMIN.password);
    expect(await sessionAudit(t, admin1.cookie)).toEqual([]);

    const other = (await sessionsOf(t, admin1.cookie)).find((s) => s.created_at.endsWith('01:00Z'));
    expect((await end(t, admin1.cookie, other?.id ?? '')).status).toBe(200);
    expect((await revokeOthers(t, admin1.cookie)).status).toBe(200);
    // A refused id writes nothing.
    expect((await end(t, admin1.cookie, '0'.repeat(32))).status).toBe(404);

    const entries = await sessionAudit(t, admin1.cookie);
    expect(entries).toEqual([
      {
        module: 'Sesiones',
        record_id: 'admin',
        action: 'SESSIONS_END_OTHERS',
        detail: '1 sesión cerrada en otros dispositivos por admin',
      },
      {
        module: 'Sesiones',
        record_id: 'admin',
        action: 'SESSION_END',
        detail: `Sesión ${other?.id ?? ''} cerrada por admin`,
      },
    ]);
    const text = JSON.stringify(entries);
    for (const token of [admin1.token, admin2.token, admin3.token]) {
      expect(text).not.toContain(token);
      expect(text).not.toContain(sha256(token));
    }
  });

  it('records ending the current session', async () => {
    const { t, admin1, admin2 } = await setup();
    const current = (await sessionsOf(t, admin2.cookie)).find((s) => s.current);
    expect((await end(t, admin2.cookie, current?.id ?? '')).status).toBe(200);
    expect(await sessionAudit(t, admin1.cookie)).toEqual([
      {
        module: 'Sesiones',
        record_id: 'admin',
        action: 'SESSION_END',
        detail: `Sesión ${current?.id ?? ''} (este dispositivo) cerrada por admin`,
      },
    ]);
  });
});
