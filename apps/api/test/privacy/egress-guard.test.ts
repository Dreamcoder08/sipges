import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  type EgressLogEntry,
  type KnownName,
  createEgressGuard,
} from '../../src/contexts/privacy/application/index.ts';

const NAMES: KnownName[] = [{ kind: 'Persona', name: 'Marcos Villanueva' }];

const setup = (options: { enabled?: boolean; failLog?: boolean } = {}) => {
  const logged: { tenantId: string; entry: EgressLogEntry }[] = [];
  const guard = createEgressGuard({
    switch: { enabled: async () => options.enabled ?? true },
    names: { load: async () => NAMES },
    keys: {
      macFor: (tenantId) => (message) =>
        createHmac('sha256', `key:${tenantId}`).update(message).digest('hex'),
    },
    log: {
      append: async (tenantId, entry) => {
        if (options.failLog) throw new Error('audit unavailable');
        logged.push({ tenantId, entry });
      },
    },
    clock: { now: () => new Date('2026-10-12T12:00:00Z') },
  });
  const open = (purpose = 'prueba') =>
    guard.open({ tenantId: 'ACME/P1', channel: 'mcp', purpose, actor: 'api:Agente (clave 1)' });
  return { open, logged };
};

describe('egress guard', () => {
  it('refuses while the project keeps the switch off, and logs nothing', async () => {
    const { open, logged } = setup({ enabled: false });
    expect(await open()).toEqual({ ok: false, reason: 'disabled' });
    expect(logged).toEqual([]);
  });

  it('scrubs every string it releases and logs one entry without values', async () => {
    const { open, logged } = setup();
    const opened = await open('get_record');
    if (!opened.ok) throw new Error('expected an open session');
    const [clean] = opened.session.records([
      {
        module: 'eventos',
        id: 'EV-1',
        marking: 'interno',
        fields: { Descripcion_Hecho: 'Habló Marcos Villanueva', Observaciones: 'x' },
      },
    ]);
    const released = await opened.session.release({
      note: 'Escribió Marcos Villanueva a a@b.org',
      clean,
      nested: ['ok', { deep: 'DNI 45678912' }],
      count: 3,
    });
    const text = JSON.stringify(released);
    expect(text).not.toContain('Marcos');
    expect(text).not.toContain('a@b.org');
    expect(text).not.toContain('45678912');
    expect(released.count).toBe(3);
    expect(logged).toHaveLength(1);
    expect(logged[0]?.tenantId).toBe('ACME/P1');
    expect(logged[0]?.entry.detail).toMatch(
      /^canal mcp · get_record · actor api:Agente \(clave 1\) · registros: eventos\/EV-1 · campos enviados: 1 · descartados: 1 \(Observaciones\) · caracteres: \d+$/,
    );
    expect(logged[0]?.entry.detail).not.toContain('Marcos');
  });

  it('releases once, and nothing leaves when the log cannot be written', async () => {
    const ok = setup();
    const opened = await ok.open();
    if (!opened.ok) throw new Error('expected an open session');
    await opened.session.release('texto');
    await expect(opened.session.release('otra vez')).rejects.toThrow();

    const failing = setup({ failLog: true });
    const second = await failing.open();
    if (!second.ok) throw new Error('expected an open session');
    await expect(second.session.release('Marcos Villanueva')).rejects.toThrow('audit unavailable');
  });

  it('logs a batch of texts as one release and seals each of them', async () => {
    const { open, logged } = setup();
    const opened = await open('index');
    if (!opened.ok) throw new Error('expected an open session');
    const texts = await opened.session.releaseMany(['uno Marcos Villanueva', 'dos']);
    expect(texts).toHaveLength(2);
    expect(texts[0]).not.toContain('Marcos');
    expect(logged).toHaveLength(1);
  });
});
