import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createSqlIdentityStore } from '../../src/contexts/identity/infrastructure/sql-identity-store.ts';
import { createTestApp } from '../support/test-app.ts';

// Independent probes of the correction round on the Cuenta session routes (compact-sidebar T4,
// A1 and A2): expiry boundary, mixed active/expired sets, a skewed `at`, and a request that tries
// to supply its own time. Synthetic accounts only.

type TestApp = Awaited<ReturnType<typeof createTestApp>>;

const ADMIN = { username: 'admin', password: 'admin-password-123' };
const ANALYST = {
  username: 'ana.perez',
  full_name: 'Ana Pérez',
  password: 'analyst-pass-123',
  role: 'analista',
};
const SCOPE = 'SIPGES/PRJ-SECHURA';
const SESSIONS = '/system/auth/sessions';
const REVOKE_OTHERS = `${SESSIONS}/revoke-others`;

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

const revokeOthers = (t: TestApp, cookie: string, path = REVOKE_OTHERS, init: RequestInit = {}) =>
  t.request(path, { method: 'POST', ...init, headers: { cookie, ...(init.headers ?? {}) } });

const listed = async (t: TestApp, cookie: string) => {
  const res = await t.request(SESSIONS, { headers: { cookie } });
  expect(res.status).toBe(200);
  return ((await res.json()) as { sessions: { id: string; current: boolean }[] }).sessions;
};

const whoIs = async (t: TestApp, cookie: string) =>
  (
    (await (await t.request('/system/auth/me', { headers: { cookie } })).json()) as {
      username: string;
    } | null
  )?.username ?? null;

const rows = async (t: TestApp) =>
  (
    await t.sql.query<{ token_hash: string; username: string }>(
      'SELECT token_hash, username FROM sessions ORDER BY token_hash',
    )
  ).map((r) => `${r.username}:${r.token_hash}`);

const sessionAudit = async (t: TestApp) =>
  (
    await t.sql.query<{ action: string; detail: string; tenant_id: string }>(
      "SELECT action, detail, tenant_id FROM audit WHERE module = 'Sesiones' ORDER BY ts, detail",
    )
  ).map((r) => `${r.tenant_id} ${r.action} ${r.detail}`);

const expireAt = (t: TestApp, token: string, at: Date) =>
  t.sql.query('UPDATE sessions SET expires_at = $1 WHERE token_hash = $2', [at, sha256(token)]);

/** admin ×4 (a1 current) and ana ×2, each one minute apart. */
const world = async () => {
  const t = await createTestApp();
  const a1 = await t.login(ADMIN.username, ADMIN.password);
  expect((await t.createAccount(a1.cookie, ANALYST)).status).toBe(200);
  await t.grant(a1.cookie, ANALYST.username);
  const more = [];
  for (let i = 0; i < 3; i += 1) {
    t.clock.advance(60);
    more.push(await t.login(ADMIN.username, ADMIN.password));
  }
  const [a2, a3, a4] = more as [typeof a1, typeof a1, typeof a1];
  const ana1 = await t.login(ANALYST.username, ANALYST.password);
  const ana2 = await t.login(ANALYST.username, ANALYST.password);
  return { t, a1, a2, a3, a4, ana1, ana2 };
};

describe('revoke-others: expiry boundary (A2)', () => {
  it('treats a session expiring exactly now as expired: not listed, not ended, not counted, not audited', async () => {
    const { t, a1, a2, a3, a4 } = await world();
    for (const s of [a2, a3, a4]) await expireAt(t, s.token, t.clock.now());
    expect(await listed(t, a1.cookie)).toHaveLength(1);
    const before = await rows(t);

    const res = await revokeOthers(t, a1.cookie);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, count: 0 });
    expect(await rows(t)).toEqual(before);
    expect(await sessionAudit(t)).toEqual([]);
    expect(await whoIs(t, a2.cookie)).toBeNull();
  });

  it('ends a session that expires one millisecond from now', async () => {
    const { t, a1, a2, a3, a4 } = await world();
    await expireAt(t, a2.token, new Date(t.clock.now().getTime() + 1));
    await expireAt(t, a3.token, t.clock.now());
    await expireAt(t, a4.token, new Date(t.clock.now().getTime() - 1));
    expect(await listed(t, a1.cookie)).toHaveLength(2);

    expect(await (await revokeOthers(t, a1.cookie)).json()).toEqual({ ok: true, count: 1 });
    const left = await rows(t);
    expect(left).not.toContain(`admin:${sha256(a2.token)}`);
    expect(left).toContain(`admin:${sha256(a3.token)}`);
    expect(left).toContain(`admin:${sha256(a4.token)}`);
    expect(left).toContain(`admin:${sha256(a1.token)}`);
  });
});

describe('revoke-others: mixed sets (A1, A2)', () => {
  it('ends the two active ones, audits once with the count, and leaves expired and foreign rows', async () => {
    const { t, a1, a2, a3, a4, ana1, ana2 } = await world();
    await expireAt(t, a3.token, new Date('2026-10-12T00:00:00Z'));
    await expireAt(t, ana2.token, new Date('2026-10-12T00:00:00Z'));

    expect(await (await revokeOthers(t, a1.cookie)).json()).toEqual({ ok: true, count: 2 });
    expect(new Set(await rows(t))).toEqual(
      new Set([
        `admin:${sha256(a1.token)}`,
        `admin:${sha256(a3.token)}`,
        `ana.perez:${sha256(ana1.token)}`,
        `ana.perez:${sha256(ana2.token)}`,
      ]),
    );
    expect(await sessionAudit(t)).toEqual([
      `${SCOPE} SESSIONS_END_OTHERS 2 sesiones cerradas en otros dispositivos por admin`,
    ]);
    expect(await whoIs(t, a1.cookie)).toBe('admin');
    expect(await whoIs(t, a2.cookie)).toBeNull();
    expect(await whoIs(t, a4.cookie)).toBeNull();
    expect(await whoIs(t, ana1.cookie)).toBe('ana.perez');
    expect((await listed(t, a1.cookie)).map((s) => s.current)).toEqual([true]);

    // Repeating it ends nothing and adds no row.
    expect(await (await revokeOthers(t, a1.cookie)).json()).toEqual({ ok: true, count: 0 });
    expect(await sessionAudit(t)).toHaveLength(1);
  });

  it('answers 404 for an expired own session and audits nothing', async () => {
    const { t, a1, a2 } = await world();
    const id = (await listed(t, a2.cookie)).find((s) => s.current)?.id ?? '';
    await expireAt(t, a2.token, t.clock.now());
    const before = await rows(t);
    const res = await t.request(`${SESSIONS}/${id}`, {
      method: 'DELETE',
      headers: { cookie: a1.cookie },
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ detail: 'Sesión inexistente' });
    expect(await rows(t)).toEqual(before);
    expect(await sessionAudit(t)).toEqual([]);
  });
});

describe('revoke-others: time source', () => {
  it('ignores any time the request supplies', async () => {
    const { t, a1, a2 } = await world();
    await expireAt(t, a2.token, new Date('2026-10-12T00:00:00Z'));
    const res = await revokeOthers(t, a1.cookie, `${REVOKE_OTHERS}?at=2000-01-01T00:00:00Z&now=0`, {
      headers: { 'content-type': 'application/json', date: 'Sat, 01 Jan 2000 00:00:00 GMT' },
      body: JSON.stringify({ at: '2000-01-01T00:00:00Z', now: '2000-01-01T00:00:00Z' }),
    });
    expect(await res.json()).toEqual({ ok: true, count: 2 });
    expect(await rows(t)).toContain(`admin:${sha256(a2.token)}`);
  });

  it.each([
    ['a clock a year behind', -365 * 86_400_000, 3],
    ['a clock a year ahead', 365 * 86_400_000, 0],
  ])('with %s still spares the kept session and other users', async (_case, skew, count) => {
    const { t, a1, a3, ana1, ana2 } = await world();
    await expireAt(t, a3.token, new Date('2026-10-12T00:00:00Z'));
    const at = new Date(t.clock.now().getTime() + skew);
    const store = createSqlIdentityStore(t.sql);
    const ended = await store.endOtherSessions(ADMIN.username, sha256(a1.token), at, SCOPE, {
      action: 'SESSIONS_END_OTHERS',
      recordId: 'admin',
      detail: (n) => `${n}`,
      at,
    });
    expect(ended).toBe(count);
    const left = await rows(t);
    expect(left).toContain(`admin:${sha256(a1.token)}`);
    expect(left).toContain(`ana.perez:${sha256(ana1.token)}`);
    expect(left).toContain(`ana.perez:${sha256(ana2.token)}`);
    expect(left.filter((r) => r.startsWith('admin:'))).toHaveLength(count === 0 ? 4 : 1);
    expect(await sessionAudit(t)).toHaveLength(count === 0 ? 0 : 1);
  });
});
