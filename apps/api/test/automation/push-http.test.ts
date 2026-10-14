import { describe, expect, it } from 'vitest';
import type { PushSender } from '../../src/contexts/automation/application/index.ts';
import { createTestApp } from '../support/test-app.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

const subscription = (n: number) => ({
  endpoint: `https://fcm.googleapis.com/fcm/send/device-${n}`,
  keys: { p256dh: `B${'a'.repeat(86)}`, auth: 'b'.repeat(22) },
});

const setup = async (pushSender: PushSender | null) => {
  const t = await createTestApp({}, { pushSender });
  const admin = await t.login('admin', 'admin-password-123');
  const call = async (method: string, path: string, body?: unknown, cookie = admin.cookie) => {
    const res = await t.request(path, {
      method,
      headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: (await res.json()) as Json };
  };
  const account = async (username: string, role: string) => {
    await t.createAccount(admin.cookie, {
      username,
      full_name: username,
      password: `${username}-password-123`,
      role,
    });
    await t.grant(admin.cookie, username);
    return (await t.login(username, `${username}-password-123`)).cookie;
  };
  return { ...t, admin, call, account };
};

describe('device notifications', () => {
  it('stay off without VAPID keys', async () => {
    const t = await setup(null);
    expect((await t.call('GET', '/system/notifications/push')).body).toEqual({
      enabled: false,
      public_key: null,
    });
    expect((await t.call('POST', '/system/notifications/push', subscription(1))).status).toBe(409);
  });

  it('push notify steps to granted devices, hide restricted ones from consulta and forget gone devices', async () => {
    const pushed: { endpoint: string; title: string; url: string }[] = [];
    const t = await setup({
      publicKey: 'BPUBLIC',
      send: async (s, payload) => {
        pushed.push({ endpoint: s.endpoint, title: payload.title, url: payload.url });
        return s.endpoint.endsWith('device-3') ? 'gone' : 'sent';
      },
    });
    expect((await t.call('GET', '/system/notifications/push')).body).toEqual({
      enabled: true,
      public_key: 'BPUBLIC',
    });
    const lector = await t.account('lector', 'consulta');
    expect((await t.call('POST', '/system/notifications/push', subscription(1))).status).toBe(200);
    expect(
      (await t.call('POST', '/system/notifications/push', subscription(2), lector)).status,
    ).toBe(200);
    expect((await t.call('POST', '/system/notifications/push', subscription(3))).status).toBe(200);
    const bad = { ...subscription(4), endpoint: 'https://evil.example/push' };
    expect((await t.call('POST', '/system/notifications/push', bad)).status).toBe(422);

    await t.call('POST', '/system/automations/rules', {
      name: 'Alertas',
      module: 'Alertas',
      actions: ['CREATE', 'UPDATE'],
      steps: [{ kind: 'notify', title: 'Alerta {id}' }],
    });
    await t.call('POST', '/api/alertas', { payload: { ID_Alerta: 'AL-1' } });
    await t.call('POST', '/system/automations/tick', {});
    expect(pushed.map((p) => p.endpoint.slice(-8)).sort()).toEqual([
      'device-1',
      'device-2',
      'device-3',
    ]);
    expect(pushed[0]).toMatchObject({ title: 'Alerta AL-1', url: '/objeto/alertas/AL-1' });

    pushed.length = 0;
    await t.call('POST', '/api/alertas', { payload: { ID_Alerta: 'AL-2' } });
    await t.call('PUT', '/system/marking', {
      module: 'alertas',
      id: 'AL-2',
      marking: 'restringido',
    });
    await t.call('PUT', '/api/alertas/AL-2', { payload: { ID_Alerta: 'AL-2', Nota: 'x' } });
    await t.call('POST', '/system/automations/tick', {});
    // Matching reads the record's current marking, so both AL-2 events are restricted: the
    // consulta device gets nothing, and device-3 (answered "gone") was forgotten.
    expect(pushed.map((p) => p.endpoint.slice(-8))).toEqual(['device-1', 'device-1']);

    await t.call('POST', '/system/notifications/push/unsubscribe', {
      endpoint: subscription(1).endpoint,
    });
    pushed.length = 0;
    await t.call('POST', '/api/alertas', { payload: { ID_Alerta: 'AL-3' } });
    await t.call('POST', '/system/automations/tick', {});
    expect(pushed.map((p) => p.endpoint.slice(-8))).toEqual(['device-2']);
  });
});
