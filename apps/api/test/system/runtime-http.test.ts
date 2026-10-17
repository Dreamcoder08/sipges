import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app.ts';
import { createSqlAutomationRuntimeStore } from '../../src/contexts/system/infrastructure/sql-automation-runtime.ts';
import { createTestApp } from '../support/test-app.ts';
const SECRET = 'synthetic-runtime-cron-secret-123';
const SCOPE = 'MASCLI/PRJ-SECHURA';
const narrative = (id: string) => ({
  payload: {
    ID_Narrativa: id,
    Descripcion: 'Exigimos agua limpia: habrá paro y bloqueo este lunes. Convocatoria a asamblea.',
    URL_Publicacion: `https://example.org/synthetic/${id}`,
    Territorio: 'Territorio documentado sintético',
  },
});
const setup = async () => {
  const t = await createTestApp({ MASCLI_CRON_SECRET: SECRET });
  const admin = await t.login('admin', 'admin-password-123');
  const app = createApp(t.container, { eventAutomation: true });
  const call = async (method: string, path: string, body?: unknown, scope = SCOPE) => {
    const r = await app.request(path, {
      method,
      headers: {
        host: 'localhost',
        origin: 'http://localhost',
        cookie: admin.cookie,
        'x-mascli-scope': scope,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  };
  const rules = async () => {
    expect(
      (
        await call('POST', '/system/automations/rules', {
          name: 'synthetic evaluate',
          module: 'Narrativas',
          actions: ['CREATE', 'UPDATE'],
          steps: [{ kind: 'evaluate', title: 'Evaluar {id}', minimum_level: 'Media' }],
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await call('POST', '/system/automations/rules', {
          name: 'synthetic notify',
          module: 'InteligenciaDigital',
          actions: ['CREATE'],
          conditions: [
            { field: 'level', op: 'eq', value: 'Media' },
            { field: 'status', op: 'eq', value: 'Pendiente de verificación' },
          ],
          steps: [{ kind: 'notify', title: 'Señal {level}' }],
        })
      ).status,
    ).toBe(200);
  };
  return { ...t, app, call, rules };
};
describe('SQL-backed event automation lifecycle', () => {
  it('processes a committed narrative into exactly one linked inbox entry without manual tick', async () => {
    const t = await setup();
    expect((await t.call('POST', '/api/narrativas', narrative('NAR-BEFORE'))).status).toBe(200);
    await t.rules();
    expect((await t.call('POST', '/api/narrativas', narrative('NAR-AFTER'))).status).toBe(200);
    const items = (await t.call('GET', '/system/notifications')).body.items as {
      href: string;
      title: string;
    }[];
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      title: 'Señal Media',
      href: expect.stringMatching(/^\/inteligencia-redes\?alert=DIG-/),
    });
    expect((await t.call('GET', '/system/automations/runtime')).body).toMatchObject({
      event_processing: true,
      cron_configured: true,
      latest_attempt: { status: 'completed', source: 'event', error: '', report: { delivered: 2 } },
    });
    expect((await t.call('PUT', '/api/narrativas/NAR-AFTER', narrative('NAR-AFTER'))).status).toBe(
      200,
    );
    expect((await t.call('GET', '/system/notifications')).body.items).toHaveLength(1);
    const prior = (await t.call('GET', '/system/automations/runtime')).body.latest_attempt;
    t.clock.advance(1);
    expect(
      (await t.call('POST', '/api/narrativas', { payload: 'invalid synthetic payload' })).status,
    ).toBeGreaterThanOrEqual(400);
    expect((await t.call('GET', '/system/automations/runtime')).body.latest_attempt).toEqual(prior);
    await t.createScope((await t.login('admin', 'admin-password-123')).cookie, {
      company_id: 'MASCLI',
      project_id: 'SYN-RUNTIME',
      label: 'Synthetic runtime isolation',
      username: 'admin',
    });
    expect(
      (await t.call('GET', '/system/notifications', undefined, 'MASCLI/SYN-RUNTIME')).body.items,
    ).toHaveLength(0);
    expect(
      (await t.call('GET', '/system/automations/runtime', undefined, 'MASCLI/SYN-RUNTIME')).body
        .latest_attempt,
    ).toBeNull();
  }, 60_000);
  it('preserves business writes on worker failure and recovers through authenticated cron', async () => {
    const t = await setup();
    await t.rules();
    const spy = vi
      .spyOn(t.container.automation, 'tick')
      .mockRejectedValueOnce(new Error('synthetic runtime failure'));
    expect((await t.call('POST', '/api/narrativas', narrative('NAR-FAIL'))).status).toBe(200);
    expect((await t.call('GET', '/system/automations/runtime')).body.latest_attempt).toMatchObject({
      source: 'event',
      status: 'failed',
      error: 'processing_failed',
      report: null,
    });
    spy.mockRestore();
    for (const headers of [{}, { authorization: 'Bearer invalid-synthetic-secret' }])
      expect(
        (
          await t.app.request('/system/automations/cron', {
            headers: { host: 'localhost', ...headers },
          })
        ).status,
      ).toBe(401);
    expect(
      (
        await t.app.request('/system/automations/cron', {
          headers: { host: 'localhost', authorization: `Bearer ${SECRET}` },
        })
      ).status,
    ).toBe(200);
    expect((await t.call('GET', '/system/notifications')).body.items).toHaveLength(1);
    expect((await t.call('GET', '/system/automations/runtime')).body.latest_attempt).toMatchObject({
      source: 'cron',
      status: 'completed',
      error: '',
    });
  });
  it('does not lose a second committed event while the first worker finishes', async () => {
    const t = await setup();
    await t.rules();
    const tasks: Promise<unknown>[] = [];
    const app = createApp(t.container, {
      eventAutomation: true,
      defer: (task) => {
        tasks.push(task);
      },
    });
    let release!: () => void;
    let scanned!: () => void;
    const firstScanned = new Promise<void>((resolve) => {
      scanned = resolve;
    });
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = t.container.automation.tick;
    const spy = vi
      .spyOn(t.container.automation, 'tick')
      .mockImplementationOnce(async (tenantId) => {
        const report = await original(tenantId);
        scanned();
        await hold;
        return report;
      });
    const cookie = (await t.login('admin', 'admin-password-123')).cookie;
    const write = (id: string) =>
      app.request('/api/narrativas', {
        method: 'POST',
        headers: {
          host: 'localhost',
          origin: 'http://localhost',
          cookie,
          'content-type': 'application/json',
        },
        body: JSON.stringify(narrative(id)),
      });
    try {
      expect((await write('NAR-CONCURRENT-A')).status).toBe(200);
      await firstScanned;
      expect((await write('NAR-CONCURRENT-B')).status).toBe(200);
    } finally {
      release();
      await Promise.all(tasks);
      spy.mockRestore();
    }
    expect((await t.call('GET', '/system/notifications')).body.items).toHaveLength(2);
  });
  it('keeps restricted events restricted under anonymous cron default limited request context', async () => {
    const t = await setup();
    const admin = await t.login('admin', 'admin-password-123');
    await t.createAccount(admin.cookie, {
      username: 'runtime.reader',
      full_name: 'Synthetic restricted reader',
      password: 'runtime-reader-password-123',
      role: 'consulta',
    });
    await t.grant(admin.cookie, 'runtime.reader');
    const reader = await t.login('runtime.reader', 'runtime-reader-password-123');
    expect(
      (
        await t.call('POST', '/system/automations/rules', {
          name: 'restricted synthetic notify',
          module: 'Narrativas',
          actions: ['CREATE'],
          steps: [{ kind: 'notify', title: 'Narrativa {Descripcion}' }],
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await t.request('/api/narrativas', {
          method: 'POST',
          headers: { cookie: admin.cookie, 'content-type': 'application/json' },
          body: JSON.stringify(narrative('NAR-RESTRICTED')),
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await t.request('/system/marking', {
          method: 'PUT',
          headers: { cookie: admin.cookie, 'content-type': 'application/json' },
          body: JSON.stringify({
            module: 'narrativas',
            id: 'NAR-RESTRICTED',
            marking: 'restringido',
          }),
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await t.app.request('/system/automations/cron', {
          headers: { host: 'localhost', authorization: `Bearer ${SECRET}` },
        })
      ).status,
    ).toBe(200);
    const items = (await t.call('GET', '/system/notifications')).body.items as { title: string }[];
    expect(items).toHaveLength(1);
    expect(items[0]?.title).toContain('[restringido]');
    expect(
      await (
        await t.request('/system/notifications', { headers: { cookie: reader.cookie } })
      ).json(),
    ).toMatchObject({ unread: 0, items: [] });
    expect((await t.call('GET', '/system/automations/runtime')).body.latest_attempt).toMatchObject({
      source: 'cron',
      status: 'completed',
      report: { delivered: 1 },
    });
  });
  it('ignores stale completion tokens in persisted evidence', async () => {
    const t = await setup();
    const store = createSqlAutomationRuntimeStore(t.sql);
    await store.start(SCOPE, 'old', 'event', t.clock.now());
    t.clock.advance(1);
    await store.start(SCOPE, 'new', 'cron', t.clock.now());
    await store.finish(
      SCOPE,
      'old',
      { status: 'failed', report: null, error: 'stale' },
      t.clock.now(),
    );
    expect(await store.state(SCOPE)).toMatchObject({
      source: 'cron',
      status: 'running',
      error: '',
      finishedAt: null,
    });
    await store.finish(
      SCOPE,
      'new',
      { status: 'completed', report: null, error: '' },
      t.clock.now(),
    );
    expect(await store.state(SCOPE)).toMatchObject({
      source: 'cron',
      status: 'completed',
      error: '',
    });
  });
});
