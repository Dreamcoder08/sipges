import { describe, expect, it, vi } from 'vitest';
import { createAutomationService } from '../../src/contexts/automation/application/automation-service.ts';
import type {
  AutomationStore,
  ChannelSender,
  ClaimedRun,
  PushStore,
  PushSender,
  SendAuditEntry,
} from '../../src/contexts/automation/application/ports.ts';
import { AUTOMATION_AUDIT_MODULE } from '../../src/contexts/automation/domain/rules.ts';

// Synthetic secrets and personal data: none of them may reach an audit row (Ley 29733).
const SECRET_URL = 'https://receiver.example.org/hooks/abc123?token=synthetic-token-value';
const SECRET = 's'.repeat(32);
const PERSON = 'Persona Sintética Uno';
const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/synthetic-endpoint-0123456789';

const channelRun = (): ClaimedRun => ({
  id: 41,
  ruleId: 7,
  ruleName: `Avisar a ${PERSON}`,
  attempts: 1,
  step: { kind: 'channel', channelId: 3, title: 'Alerta {id}' },
  event: {
    auditId: 900,
    at: new Date('2026-11-02T00:00:00Z'),
    module: 'Alertas',
    recordId: 'AL-1',
    action: 'CREATE',
    detail: `Alerta creada por ${PERSON}`,
    record: { payload: { ID_Alerta: 'AL-1', Responsable: PERSON }, marking: 'interno' },
  },
});

const setup = (options: { send?: ChannelSender['send']; auditFails?: boolean } = {}) => {
  const entries: { tenantId: string; entry: SendAuditEntry }[] = [];
  const audit = {
    append: vi.fn(async (tenantId: string, entry: SendAuditEntry) => {
      if (options.auditFails) throw new Error('audit table unavailable');
      entries.push({ tenantId, entry });
    }),
  };
  const store = {
    scan: vi.fn(async () => ({ scanned: 0, queued: 0 })),
    claimDue: vi.fn(async (): Promise<ClaimedRun[]> => []),
    finishRun: vi.fn(async () => {}),
    sealedChannel: vi.fn(async () =>
      JSON.stringify({ kind: 'webhook', url: SECRET_URL, secret: SECRET }),
    ),
  };
  const send = vi.fn(options.send ?? (async () => {}));
  const subscription = { endpoint: ENDPOINT, p256dh: 'p'.repeat(87), auth: 'a'.repeat(22) };
  const pushDeliveries = [
    {
      id: 5,
      subscription,
      payload: { title: `Aviso para ${PERSON}`, body: PERSON, url: '/' },
      attempts: 1,
    },
  ];
  const pushStore = {
    claim: vi.fn(async () => pushDeliveries.splice(0)),
    finish: vi.fn(async () => {}),
    forget: vi.fn(async () => {}),
    ownTargets: vi.fn(async () => [subscription]),
  };
  const pushSend = vi.fn(async (): Promise<'sent' | 'gone'> => 'sent');
  const service = createAutomationService({
    store: store as unknown as AutomationStore,
    sender: { send },
    sealer: { seal: (s) => s, open: (s) => s },
    clock: { now: () => new Date('2026-11-02T00:00:00Z') },
    recordModules: [],
    audit,
    push: {
      store: pushStore as unknown as PushStore,
      sender: { publicKey: 'k', send: pushSend } as PushSender,
    },
  });
  return { service, store, send, audit, entries, pushSend, pushStore };
};

/** Every string an audit row may never carry. */
const FORBIDDEN = [
  SECRET_URL,
  'receiver.example.org',
  'synthetic-token-value',
  SECRET,
  PERSON,
  'Alerta AL-1',
  ENDPOINT,
  'fcm.googleapis.com',
  'connection refused by receiver.example.org',
];

const expectNoPersonalData = (entries: { entry: SendAuditEntry }[]) => {
  const text = JSON.stringify(entries);
  for (const forbidden of FORBIDDEN) expect(text).not.toContain(forbidden);
};

describe('audit of automation channel sends (S8)', () => {
  it('writes one tenant-scoped row for a successful rule send', async () => {
    const { service, store, entries } = setup();
    store.claimDue.mockResolvedValueOnce([channelRun()]);
    await service.tick('SIPGES/PRJ-A');
    expect(entries.filter((e) => e.entry.action === 'CHANNEL_SEND')).toEqual([
      {
        tenantId: 'SIPGES/PRJ-A',
        entry: {
          module: AUTOMATION_AUDIT_MODULE,
          recordId: null,
          action: 'CHANNEL_SEND',
          detail: 'Envío webhook · regla 7 · canal 3 · evento 900 · enviado',
          at: new Date('2026-11-02T00:00:00Z'),
        },
      },
    ]);
    expectNoPersonalData(entries);
  });

  it('writes one row for a failed rule send and still schedules the retry', async () => {
    const { service, store, entries } = setup({
      send: async () => {
        throw new Error('connection refused by receiver.example.org');
      },
    });
    store.claimDue.mockResolvedValueOnce([channelRun()]);
    const report = await service.tick('SIPGES/PRJ-A');
    expect(report).toMatchObject({ delivered: 0, retrying: 1 });
    expect(
      entries.filter((e) => e.entry.action === 'CHANNEL_SEND').map((e) => e.entry.detail),
    ).toEqual(['Envío webhook · regla 7 · canal 3 · evento 900 · fallido']);
    expectNoPersonalData(entries);
  });

  it('does not audit runs that send nothing to a channel', async () => {
    const { service, store, entries } = setup();
    store.claimDue.mockResolvedValueOnce([
      { ...channelRun(), step: { kind: 'notify', title: 'Aviso' } },
    ]);
    (store as unknown as { notify: () => Promise<number> }).notify = async () => 1;
    await service.tick('SIPGES/PRJ-A');
    expect(entries.filter((e) => e.entry.action === 'CHANNEL_SEND')).toEqual([]);
  });

  it('audits a channel test with its outcome', async () => {
    const ok = setup();
    expect(await ok.service.testChannel('SIPGES/PRJ-A', 3)).toEqual({ ok: true, value: true });
    const failing = setup({
      send: async () => {
        throw new Error('connection refused by receiver.example.org');
      },
    });
    expect((await failing.service.testChannel('SIPGES/PRJ-A', 3)).ok).toBe(false);
    expect([...ok.entries, ...failing.entries].map((e) => [e.tenantId, e.entry.detail])).toEqual([
      ['SIPGES/PRJ-A', 'Prueba de canal webhook · canal 3 · enviado'],
      ['SIPGES/PRJ-A', 'Prueba de canal webhook · canal 3 · fallido'],
    ]);
    expectNoPersonalData([...ok.entries, ...failing.entries]);
  });

  it('audits each push delivery without the endpoint', async () => {
    const accepted = setup();
    await accepted.service.tick('SIPGES/PRJ-A');
    const rejected = setup();
    rejected.pushSend.mockRejectedValueOnce(new Error('push service fcm.googleapis.com said 500'));
    await rejected.service.tick('SIPGES/PRJ-A');
    expect(
      [...accepted.entries, ...rejected.entries].map((e) => [e.entry.action, e.entry.detail]),
    ).toEqual([
      ['PUSH_SEND', 'Envío push · entrega 5 · aceptado'],
      ['PUSH_SEND', 'Envío push · entrega 5 · fallido'],
    ]);
    expectNoPersonalData([...accepted.entries, ...rejected.entries]);
  });

  it('audits a push already sent even when recording its outcome fails', async () => {
    const { service, pushStore, entries } = setup();
    pushStore.finish.mockRejectedValue(new Error('database unavailable'));
    await service.tick('SIPGES/PRJ-A').catch(() => {});
    expect(entries.map((e) => e.entry.detail)).toEqual(['Envío push · entrega 5 · aceptado']);
  });

  it('audits a push test in the active tenant without naming the person', async () => {
    const { service, entries } = setup();
    const result = await service.testPush('persona.sintetica', 'SIPGES/PRJ-A');
    expect(result.status).toBe('accepted');
    expect(entries.map((e) => [e.tenantId, e.entry.action, e.entry.detail])).toEqual([
      ['SIPGES/PRJ-A', 'PUSH_SEND', 'Prueba de push · 1 aceptados · 0 fallidos'],
    ]);
    expect(JSON.stringify(entries)).not.toContain('persona.sintetica');
    expectNoPersonalData(entries);
  });

  it('never breaks or repeats a send when the audit write fails', async () => {
    const { service, store, send, audit } = setup({ auditFails: true });
    store.claimDue.mockResolvedValueOnce([channelRun()]);
    const report = await service.tick('SIPGES/PRJ-A');
    expect(report).toMatchObject({ delivered: 1, retrying: 0, failed: 0 });
    expect(send).toHaveBeenCalledTimes(1);
    expect(store.finishRun).toHaveBeenCalledWith(
      'SIPGES/PRJ-A',
      41,
      { status: 'done' },
      expect.any(Date),
    );
    expect(await service.testChannel('SIPGES/PRJ-A', 3)).toEqual({ ok: true, value: true });
    expect(audit.append).toHaveBeenCalled();
  });
});
