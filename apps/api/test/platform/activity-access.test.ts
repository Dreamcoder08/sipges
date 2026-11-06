import { describe, expect, it } from 'vitest';
import { createTestApp } from '../support/test-app.ts';

/**
 * An open stream keeps its access only while that access lasts: module and action names must
 * stop within a poll of a logout, an expired session, a deactivated account or a revoked grant.
 * The Go twin is apps/api-go/internal/audit/http/activity_access_integration_test.go.
 */
const POLL = 20;

/** Reads the stream as it arrives; `ended` is false when it outlives `timeoutMs`. */
const follow = (res: Response, timeoutMs: number) => {
  if (!res.body) throw new Error('No stream body');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  const finished = (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return true;
      text += decoder.decode(value, { stream: true });
    }
  })();
  return {
    text: () => text,
    ended: () =>
      Promise.race([
        finished,
        new Promise<false>((resolve) => {
          setTimeout(() => resolve(false), timeoutMs);
        }),
      ]),
    close: () => reader.cancel().catch(() => undefined),
  };
};

const activity = (text: string) => text.split('event: activity').length - 1;
const settle = () => new Promise((resolve) => setTimeout(resolve, POLL * 5));

const open = async () => {
  const t = await createTestApp({}, { activity: { pollMs: POLL, maxMs: 1_500 } });
  const admin = await t.login('admin', 'admin-password-123');
  const created = await t.createAccount(admin.cookie, {
    username: 'oyente',
    full_name: 'Oyente sintético',
    password: 'oyente-password-123',
    role: 'analista',
  });
  expect(created.status).toBe(200);
  await t.grant(admin.cookie, 'oyente');
  const user = await t.login('oyente', 'oyente-password-123');
  const res = await t.request('/system/events', { headers: { cookie: user.cookie } });
  expect(res.status).toBe(200);
  const stream = follow(res, 1_000);
  const write = (id: string) =>
    t.request('/api/demandas', {
      method: 'POST',
      headers: { cookie: admin.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ payload: { ID_Demanda: id, Demanda: 'Sintética' } }),
    });
  await settle();
  await write('D-ANTES');
  await settle();
  expect(activity(stream.text())).toBe(1);
  return { t, admin, user, stream, write };
};

describe('live activity stream after access ends', () => {
  const ways: Record<string, (h: Awaited<ReturnType<typeof open>>) => unknown> = {
    logout: (h) =>
      h.t.request('/logout', {
        method: 'POST',
        headers: { cookie: h.user.cookie, origin: 'http://localhost' },
      }),
    'an expired session': (h) =>
      h.t.sql.query(`UPDATE sessions SET expires_at = '2000-01-01' WHERE username = 'oyente'`),
    'a deactivated account': (h) =>
      h.t.sql.query(`UPDATE users SET active = false WHERE username = 'oyente'`),
    'a revoked grant': (h) =>
      h.t.request('/system/auth/grants', {
        method: 'DELETE',
        headers: { cookie: h.admin.cookie, 'content-type': 'application/json' },
        body: JSON.stringify({
          username: 'oyente',
          company_id: 'SIPGES',
          project_id: 'PRJ-SECHURA',
        }),
      }),
  };

  for (const [name, end] of Object.entries(ways)) {
    it(`ends after ${name}`, async () => {
      const h = await open();
      await end(h);
      await settle();
      await h.write('D-DESPUES');
      expect(await h.stream.ended()).toBe(true);
      expect(activity(h.stream.text())).toBe(1);
    });
  }

  it('keeps going while access lasts', async () => {
    const h = await open();
    await h.write('D-OTRA');
    await settle();
    expect(activity(h.stream.text())).toBe(2);
    await h.stream.close();
  });
});
