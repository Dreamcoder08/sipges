import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { MFA_REQUIRED_DETAIL } from '../../src/contexts/identity/http/auth-middleware.ts';
import { createSqlIdentityStore } from '../../src/contexts/identity/infrastructure/sql-identity-store.ts';
import { createTestApp } from '../support/test-app.ts';

// Regression tests from the independent review of the Cuenta session routes (compact-sidebar
// T4): project scope, exact body, logout equivalence, Origin, role paths, MFA, atomic audit,
// and «cerrar sesión en todos los demás» counting only active sessions with no empty audit row.
// Synthetic accounts only.

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
const DEFAULT_SCOPE = 'SIPGES/PRJ-SECHURA';
const SESSIONS = '/system/auth/sessions';
const REVOKE_OTHERS = `${SESSIONS}/revoke-others`;
const NO_PROJECT = 'Seleccione un proyecto autorizado mediante X-SIPGES-Scope o /select-project';
const READ_ONLY = 'Rol de consulta: solo lectura';

type Session = { id: string; created_at: string; current: boolean };

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

const scoped = (cookie: string, scope?: string): Record<string, string> =>
  scope ? { cookie, 'x-sipges-scope': scope } : { cookie };

const sessionsOf = async (t: TestApp, cookie: string, scope?: string) => {
  const res = await t.request(SESSIONS, { headers: scoped(cookie, scope) });
  expect(res.status).toBe(200);
  return ((await res.json()) as { sessions: Session[] }).sessions;
};

const end = (t: TestApp, cookie: string, id: string, headers: Record<string, string> = {}) =>
  t.request(`${SESSIONS}/${id}`, { method: 'DELETE', headers: { cookie, ...headers } });

const revokeOthers = (t: TestApp, cookie: string, headers: Record<string, string> = {}) =>
  t.request(REVOKE_OTHERS, { method: 'POST', headers: { cookie, ...headers } });

const whoIs = async (t: TestApp, cookie: string) =>
  (
    (await (await t.request('/system/auth/me', { headers: { cookie } })).json()) as {
      username: string;
    } | null
  )?.username ?? null;

const sessionAudit = async (t: TestApp, cookie: string, scope?: string) => {
  const res = await t.request('/system/audit', { headers: scoped(cookie, scope) });
  expect(res.status).toBe(200);
  return ((await res.json()) as { module: string; action: string; detail: string | null }[])
    .filter((entry) => entry.module === 'Sesiones')
    .map(({ action, detail }) => ({ action, detail }));
};

/** The administrator with two sessions, one minute apart. */
const twoAdminSessions = async (env: Record<string, string> = {}) => {
  const t = await createTestApp(env);
  const admin1 = await t.login(ADMIN.username, ADMIN.password);
  t.clock.advance(60);
  const admin2 = await t.login(ADMIN.username, ADMIN.password);
  return { t, admin1, admin2 };
};

describe('session routes: project scope', () => {
  it('refuse an account with no project grant, whose /logout still works', async () => {
    const { t, admin1 } = await twoAdminSessions();
    expect((await t.createAccount(admin1.cookie, ANALYST)).status).toBe(200);
    const first = await t.login(ANALYST.username, ANALYST.password);
    t.clock.advance(60);
    const second = await t.login(ANALYST.username, ANALYST.password);

    for (const res of [
      await t.request(SESSIONS, { headers: { cookie: second.cookie } }),
      await end(t, second.cookie, '0'.repeat(32)),
      await revokeOthers(t, second.cookie),
    ]) {
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ detail: NO_PROJECT, projects: [] });
    }
    expect(await whoIs(t, first.cookie)).toBe(ANALYST.username);

    const out = await t.request('/logout', { method: 'POST', headers: { cookie: second.cookie } });
    expect(out.status).toBe(200);
    expect(await out.json()).toEqual({ ok: true });
    expect(await whoIs(t, second.cookie)).toBeNull();
    expect(await whoIs(t, first.cookie)).toBe(ANALYST.username);
  });

  it('writes the audit row only in the project the request chose', async () => {
    const { t, admin1, admin2 } = await twoAdminSessions();
    const created = await t.createScope(admin1.cookie, {
      company_id: 'ACME',
      project_id: 'NORTE',
      label: 'Proyecto Norte sintético',
      username: ADMIN.username,
    });
    expect(created.status).toBe(200);
    t.clock.advance(60);
    const admin3 = await t.login(ADMIN.username, ADMIN.password);

    const other = (await sessionsOf(t, admin3.cookie, 'ACME/NORTE')).find(
      (s) => s.created_at === '2026-10-12T12:00:00Z',
    );
    const ended = await end(t, admin3.cookie, other?.id ?? '', { 'x-sipges-scope': 'ACME/NORTE' });
    expect(ended.status).toBe(200);
    expect(await whoIs(t, admin1.cookie)).toBeNull();

    expect(await sessionAudit(t, admin3.cookie, 'ACME/NORTE')).toEqual([
      { action: 'SESSION_END', detail: `Sesión ${other?.id ?? ''} cerrada por admin` },
    ]);
    expect(await sessionAudit(t, admin3.cookie, DEFAULT_SCOPE)).toEqual([]);

    const revoked = await revokeOthers(t, admin3.cookie, { 'x-sipges-scope': DEFAULT_SCOPE });
    expect(await revoked.json()).toEqual({ ok: true, count: 1 });
    expect(await whoIs(t, admin2.cookie)).toBeNull();
    expect(await sessionAudit(t, admin3.cookie, DEFAULT_SCOPE)).toEqual([
      {
        action: 'SESSIONS_END_OTHERS',
        detail: '1 sesión cerrada en otros dispositivos por admin',
      },
    ]);
    expect(await sessionAudit(t, admin3.cookie, 'ACME/NORTE')).toHaveLength(1);
  });
});

describe('session routes: answers', () => {
  it('list each session with exactly id, created_at, expires_at, method and current', async () => {
    const { t, admin1 } = await twoAdminSessions();
    const body = (await (
      await t.request(SESSIONS, { headers: { cookie: admin1.cookie } })
    ).json()) as {
      sessions: Record<string, unknown>[];
    };
    expect(Object.keys(body)).toEqual(['sessions']);
    expect(body.sessions).toHaveLength(2);
    for (const session of body.sessions) {
      expect(Object.keys(session).sort()).toEqual([
        'created_at',
        'current',
        'expires_at',
        'id',
        'method',
      ]);
    }
  });

  it('end the current session with the Set-Cookie of /logout; replaying the id is 401', async () => {
    const { t, admin1, admin2 } = await twoAdminSessions();
    const current = (await sessionsOf(t, admin1.cookie)).find((s) => s.current);
    const ended = await end(t, admin1.cookie, current?.id ?? '');
    expect(ended.status).toBe(200);
    const out = await t.request('/logout', { method: 'POST', headers: { cookie: admin2.cookie } });
    expect(out.status).toBe(200);
    expect(ended.headers.getSetCookie()).toEqual(out.headers.getSetCookie());
    expect(ended.headers.getSetCookie()).toHaveLength(2);

    const replay = await end(t, admin1.cookie, current?.id ?? '');
    expect(replay.status).toBe(401);
    expect(await replay.json()).toEqual({ detail: 'Inicie sesión para acceder a SIPGES' });
  });
});

describe('session routes: refusals', () => {
  it.each([
    ['without Origin or Referer', { origin: '' }],
    ['with Origin: null', { origin: 'null' }],
    ['with a cross-site Origin', { origin: 'https://evil.example' }],
    ['with a cross-site Referer', { origin: '', referer: 'https://evil.example/cuenta' }],
  ])('refuse writes %s, end nothing and audit nothing', async (_case, headers) => {
    const { t, admin1, admin2 } = await twoAdminSessions();
    const other = (await sessionsOf(t, admin1.cookie)).find((s) => !s.current);
    for (const res of [
      await end(t, admin1.cookie, other?.id ?? '', headers),
      await revokeOthers(t, admin1.cookie, headers),
    ]) {
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ detail: 'Origen de solicitud no permitido' });
    }
    expect(await whoIs(t, admin2.cookie)).toBe(ADMIN.username);
    expect(await sessionsOf(t, admin1.cookie)).toHaveLength(2);
    expect(await sessionAudit(t, admin1.cookie)).toEqual([]);
  });

  it('give a read-only account 403 on every path that is not exactly its own session', async () => {
    const { t, admin1 } = await twoAdminSessions();
    expect((await t.createAccount(admin1.cookie, READER)).status).toBe(200);
    await t.grant(admin1.cookie, READER.username);
    const first = await t.login(READER.username, READER.password);
    t.clock.advance(60);
    const second = await t.login(READER.username, READER.password);
    const id = (await sessionsOf(t, second.cookie)).find((s) => !s.current)?.id ?? '';

    const table: readonly (readonly [string, string, string?])[] = [
      ['DELETE', `${SESSIONS}/`],
      ['DELETE', SESSIONS],
      ['DELETE', `${SESSIONS}/${id}/`],
      ['DELETE', `${SESSIONS}/${id}/extra`],
      ['DELETE', `${SESSIONS}//${id}`],
      ['DELETE', `${SESSIONS}/%2e%2e`],
      ['DELETE', `${SESSIONS}/${id}/..`],
      // Resolved to /system/auth/accounts before any gate reads it.
      ['DELETE', `${SESSIONS}/../accounts`, 'Administración de cuentas restringida'],
      ['POST', `${SESSIONS}/${id}`],
      ['PUT', `${SESSIONS}/${id}`],
      ['PATCH', `${SESSIONS}/${id}`],
      ['POST', `${REVOKE_OTHERS}/`],
      ['DELETE', REVOKE_OTHERS.replace('revoke-others', 'revoke-others/x')],
    ];
    for (const [method, path, detail = READ_ONLY] of table) {
      const res = await t.request(path, { method, headers: { cookie: second.cookie } });
      expect([method, path, res.status]).toEqual([method, path, 403]);
      expect([method, path, await res.json()]).toEqual([method, path, { detail }]);
    }
    expect(await whoIs(t, first.cookie)).toBe(READER.username);
    expect(await sessionsOf(t, second.cookie)).toHaveLength(2);
  });

  it('answer 403 mfa_required until the session enrolls MFA, and end nothing', async () => {
    const { t, admin1, admin2 } = await twoAdminSessions({ SIPGES_REQUIRE_MFA: '1' });
    for (const res of [
      await t.request(SESSIONS, { headers: { cookie: admin1.cookie } }),
      await end(t, admin1.cookie, '0'.repeat(32)),
      await revokeOthers(t, admin1.cookie),
    ]) {
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ detail: MFA_REQUIRED_DETAIL, mfa_required: true });
    }
    expect(await whoIs(t, admin2.cookie)).toBe(ADMIN.username);
  });
});

describe('session writes: atomicity and counting', () => {
  it('roll the session back when the audit row cannot be written', async () => {
    const { t, admin1, admin2 } = await twoAdminSessions();
    const other = (await sessionsOf(t, admin1.cookie)).find((s) => !s.current);
    await t.sql.query(`CREATE FUNCTION refuse_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'synthetic audit failure'; END $$`);
    await t.sql.query(
      'CREATE TRIGGER refuse_audit BEFORE INSERT ON audit FOR EACH ROW EXECUTE FUNCTION refuse_audit()',
    );

    expect((await end(t, admin1.cookie, other?.id ?? '')).status).toBe(500);
    expect((await revokeOthers(t, admin1.cookie)).status).toBe(500);
    expect(await whoIs(t, admin2.cookie)).toBe(ADMIN.username);
    expect(await sessionsOf(t, admin1.cookie)).toHaveLength(2);
  });

  it("end only that user's sessions when the kept one is already gone", async () => {
    const { t, admin1, admin2 } = await twoAdminSessions();
    expect((await t.createAccount(admin1.cookie, ANALYST)).status).toBe(200);
    await t.grant(admin1.cookie, ANALYST.username);
    const ana = await t.login(ANALYST.username, ANALYST.password);

    const store = createSqlIdentityStore(t.sql);
    const count = await store.endOtherSessions(
      ADMIN.username,
      sha256('a session that no longer exists'),
      t.clock.now(),
      DEFAULT_SCOPE,
      {
        action: 'SESSIONS_END_OTHERS',
        recordId: 'admin',
        detail: (n) => `${n}`,
        at: t.clock.now(),
      },
    );
    expect(count).toBe(2);
    expect(await whoIs(t, admin1.cookie)).toBeNull();
    expect(await whoIs(t, admin2.cookie)).toBeNull();
    expect(await whoIs(t, ana.cookie)).toBe(ANALYST.username);
  });

  it('write no audit row when no other session was open, whatever the role', async () => {
    const { t, admin1, admin2 } = await twoAdminSessions();
    expect((await t.createAccount(admin1.cookie, READER)).status).toBe(200);
    await t.grant(admin1.cookie, READER.username);
    const reader = await t.login(READER.username, READER.password);

    for (let i = 0; i < 3; i += 1) {
      const res = await revokeOthers(t, reader.cookie);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, count: 0 });
    }
    expect(await sessionAudit(t, admin1.cookie)).toEqual([]);

    expect(await (await revokeOthers(t, admin1.cookie)).json()).toEqual({ ok: true, count: 1 });
    expect(await (await revokeOthers(t, admin1.cookie)).json()).toEqual({ ok: true, count: 0 });
    expect(await whoIs(t, admin2.cookie)).toBeNull();
    expect(await sessionAudit(t, admin1.cookie)).toEqual([
      { action: 'SESSIONS_END_OTHERS', detail: '1 sesión cerrada en otros dispositivos por admin' },
    ]);
  });

  it('count and end only active sessions, as the list shows them', async () => {
    const { t, admin1, admin2 } = await twoAdminSessions();
    t.clock.advance(60);
    const admin3 = await t.login(ADMIN.username, ADMIN.password);
    // Expired but not yet purged (purging happens at the next sign-in).
    await t.sql.query(
      "UPDATE sessions SET expires_at = '2026-10-12T00:00:00Z' WHERE token_hash = $1",
      [sha256(admin2.token)],
    );
    expect(await sessionsOf(t, admin1.cookie)).toHaveLength(2);

    const res = await revokeOthers(t, admin1.cookie);
    expect(await res.json()).toEqual({ ok: true, count: 1 });
    expect(await whoIs(t, admin3.cookie)).toBeNull();
    expect(await sessionAudit(t, admin1.cookie)).toEqual([
      { action: 'SESSIONS_END_OTHERS', detail: '1 sesión cerrada en otros dispositivos por admin' },
    ]);
    expect((await sessionsOf(t, admin1.cookie)).map((s) => s.current)).toEqual([true]);
  });
});
