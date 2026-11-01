import { describe, expect, it } from 'vitest';
import type { ChannelSender } from '../../src/contexts/automation/application/index.ts';
import { createTestApp } from '../support/test-app.ts';

// Response bodies are inspected loosely; their shapes are covered by the contracts.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

const CRON_SECRET = 'cron-secret-synthetic-0123456789';

const setup = async (options: { channelSender?: ChannelSender } = {}) => {
  const t = await createTestApp({ SIPGES_CRON_SECRET: CRON_SECRET }, options);
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
  const webhook = async () =>
    (
      await call('POST', '/system/automations/channels', {
        kind: 'webhook',
        name: 'Sistema externo',
        settings: { url: 'https://receiver.example.org/sipges', secret: 's'.repeat(32) },
      })
    ).body.id as number;
  const alertRule = async (channelId: number) =>
    call('POST', '/system/automations/rules', {
      name: 'Alertas altas',
      module: 'Alertas',
      actions: ['CREATE', 'UPDATE'],
      conditions: [{ field: 'Nivel', op: 'eq', value: 'Alto' }],
      steps: [
        { kind: 'notify', title: 'Alerta {id}: {Descripcion}' },
        { kind: 'channel', channel_id: channelId, title: 'Alerta alta {id}' },
      ],
    });
  return { ...t, admin, call, account, webhook, alertRule };
};

describe('automations', () => {
  it('turns a matching write into an in-app notification and a signed webhook', async () => {
    const t = await setup();
    await t.call('POST', '/api/alertas', { payload: { ID_Alerta: 'AL-0', Nivel: 'Alto' } });
    const channelId = await t.webhook();
    expect((await t.alertRule(channelId)).status).toBe(200);

    await t.call('POST', '/api/alertas', {
      payload: { ID_Alerta: 'AL-1', Nivel: 'Alto', Descripcion: 'Bloqueo de vía sintético' },
    });
    await t.call('POST', '/api/alertas', { payload: { ID_Alerta: 'AL-2', Nivel: 'Bajo' } });

    const tick = await t.call('POST', '/system/automations/tick', {});
    expect(tick.body).toMatchObject({ tenants: 1, queued: 2, delivered: 2, failed: 0 });
    // The alert created before the rule existed never fires.
    expect(t.sent).toHaveLength(1);
    const [sent] = t.sent;
    expect(sent?.config).toMatchObject({
      kind: 'webhook',
      url: 'https://receiver.example.org/sipges',
    });
    expect(sent?.message).toMatchObject({
      title: 'Alerta alta AL-1',
      event: {
        type: 'sipges.alertas.create',
        module: 'Alertas',
        record_id: 'AL-1',
        record: { ID_Alerta: 'AL-1', Nivel: 'Alto' },
      },
    });

    const inbox = await t.call('GET', '/system/notifications');
    expect(inbox.body.unread).toBe(1);
    expect(inbox.body.items[0]).toMatchObject({
      title: 'Alerta AL-1: Bloqueo de vía sintético',
      module: 'Alertas',
      record_id: 'AL-1',
      read: false,
    });

    const overview = await t.call('GET', '/system/automations');
    expect(overview.body.runs.map((r: Json) => r.status)).toEqual(['done', 'done']);
    expect(overview.body.channels[0]).toEqual(
      expect.objectContaining({ kind: 'webhook', target_hint: 'receiver.example.org' }),
    );
    expect(JSON.stringify(overview.body)).not.toContain('s'.repeat(32));

    // A second tick finds nothing new: runs are idempotent.
    expect((await t.call('POST', '/system/automations/tick', {})).body).toMatchObject({
      queued: 0,
      delivered: 0,
    });
    // Rule edits are audited under the automation module, which never triggers rules.
    const audit = await t.call('GET', '/system/audit?limit=20');
    expect((audit.body as unknown as Json[]).some((a) => a.module === 'Automatizaciones')).toBe(
      true,
    );
  });

  it('announces restricted records by reference only', async () => {
    const t = await setup();
    const channelId = await t.webhook();
    await t.alertRule(channelId);
    await t.call('POST', '/api/alertas', {
      payload: { ID_Alerta: 'AL-9', Nivel: 'Alto', Descripcion: 'Dato sensible' },
    });
    await t.call('PUT', '/system/marking', {
      module: 'alertas',
      id: 'AL-9',
      marking: 'restringido',
    });
    await t.call('PUT', '/api/alertas/AL-9', {
      payload: { ID_Alerta: 'AL-9', Nivel: 'Alto', Descripcion: 'Dato sensible 2' },
    });
    await t.call('POST', '/system/automations/tick', {});
    const restricted = t.sent.at(-1)?.message;
    expect(restricted?.event).toMatchObject({
      record_id: 'AL-9',
      record: null,
      marking: 'restringido',
    });
    expect(JSON.stringify(restricted)).not.toContain('Dato sensible');

    // A read-only account does not see notifications about restricted records.
    const consulta = await t.account('lectora', 'consulta');
    const inbox = await t.call('GET', '/system/notifications', undefined, consulta);
    expect(inbox.body.items.map((n: Json) => n.record_id)).not.toContain('AL-9');
  });

  it('retries failed deliveries with backoff and records the error', async () => {
    let failures = 1;
    const sent: string[] = [];
    const t = await setup({
      channelSender: {
        send: async (_config, message) => {
          if (failures-- > 0) throw new Error('Canal webhook: respuesta HTTP 503');
          sent.push(message.title);
        },
      },
    });
    await t.alertRule(await t.webhook());
    await t.call('POST', '/api/alertas', { payload: { ID_Alerta: 'AL-3', Nivel: 'Alto' } });

    expect((await t.call('POST', '/system/automations/tick', {})).body).toMatchObject({
      delivered: 1,
      retrying: 1,
    });
    const pending = (await t.call('GET', '/system/automations/runs')).body as unknown as Json[];
    expect(pending.find((r) => r.kind === 'channel')).toMatchObject({
      status: 'pending',
      attempts: 1,
      last_error: 'Canal webhook: respuesta HTTP 503',
    });

    // Not due yet; after the one-minute backoff it is delivered.
    expect((await t.call('POST', '/system/automations/tick', {})).body.delivered).toBe(0);
    t.clock.advance(61);
    expect((await t.call('POST', '/system/automations/tick', {})).body.delivered).toBe(1);
    expect(sent).toEqual(['Alerta alta AL-3']);
  });

  it('keeps configuration to administrators and the inbox to every member', async () => {
    const t = await setup();
    const analista = await t.account('ana', 'analista');
    expect((await t.call('GET', '/system/automations', undefined, analista)).status).toBe(403);
    expect((await t.call('POST', '/system/automations/tick', {}, analista)).status).toBe(403);

    await t.alertRule(await t.webhook());
    await t.call('POST', '/api/alertas', { payload: { ID_Alerta: 'AL-4', Nivel: 'Alto' } });
    await t.call('POST', '/system/automations/tick', {});

    const consulta = await t.account('lector', 'consulta');
    const inbox = await t.call('GET', '/system/notifications', undefined, consulta);
    expect(inbox.body.unread).toBe(1);
    expect(
      (await t.call('POST', '/system/notifications/read', { all: true }, consulta)).status,
    ).toBe(200);
    expect((await t.call('GET', '/system/notifications', undefined, consulta)).body.unread).toBe(0);
    // Read state is per person.
    expect((await t.call('GET', '/system/notifications')).body.unread).toBe(1);
  });

  it('lets a cron job tick every tenant only with the bearer secret', async () => {
    const t = await setup();
    await t.alertRule(await t.webhook());
    await t.call('POST', '/api/alertas', { payload: { ID_Alerta: 'AL-5', Nivel: 'Alto' } });

    const cron = (authorization?: string) =>
      t.request('/system/automations/cron', {
        method: 'POST',
        headers: { origin: '', ...(authorization ? { authorization } : {}) },
      });
    expect((await cron()).status).toBe(401);
    expect((await cron('Bearer wrong-secret')).status).toBe(401);
    const ok = await cron(`Bearer ${CRON_SECRET}`);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ tenants: 1, delivered: 2 });
    const viaGet = await t.request('/system/automations/cron', {
      headers: { authorization: `Bearer ${CRON_SECRET}` },
    });
    expect(viaGet.status).toBe(200);
  });

  it('validates channels and rules and protects channels in use', async () => {
    const t = await setup();
    const bad = await t.call('POST', '/system/automations/channels', {
      kind: 'slack',
      name: 'Slack',
      settings: { url: 'https://example.org/not-slack' },
    });
    expect(bad).toMatchObject({
      status: 422,
      body: { detail: 'La URL no corresponde al servicio elegido' },
    });
    const local = await t.call('POST', '/system/automations/channels', {
      kind: 'webhook',
      name: 'Local',
      settings: { url: 'https://127.0.0.1/x', secret: 's'.repeat(32) },
    });
    expect(local.status).toBe(422);

    const channelId = await t.webhook();
    const rule = await t.alertRule(channelId);
    expect((await t.alertRule(channelId)).status).toBe(409);
    expect(
      (
        await t.call('POST', '/system/automations/rules', {
          name: 'Origen raro',
          module: 'Planetas',
          actions: ['CREATE'],
          steps: [{ kind: 'notify', title: 'x' }],
        })
      ).status,
    ).toBe(422);

    expect((await t.call('DELETE', `/system/automations/channels/${channelId}`)).status).toBe(409);
    expect((await t.call('DELETE', `/system/automations/rules/${rule.body.id}`)).status).toBe(200);
    expect((await t.call('DELETE', `/system/automations/channels/${channelId}`)).status).toBe(200);
  });

  it('sends a test message through a channel on demand', async () => {
    const t = await setup();
    const channelId = await t.webhook();
    const res = await t.call('POST', `/system/automations/channels/${channelId}/test`, {});
    expect(res.status).toBe(200);
    expect(t.sent[0]?.message.title).toBe('Prueba de SIPGES');
  });
});
