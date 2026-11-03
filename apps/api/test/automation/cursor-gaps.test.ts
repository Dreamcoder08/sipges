import { expect, it } from 'vitest';
import { createTestApp } from '../support/test-app.ts';

const TENANT = 'SIPGES/PRJ-SECHURA';

it('still notifies an audit event that commits after a higher id was already scanned', async () => {
  // Audit ids are handed out when a row is inserted, not when its transaction commits: a
  // slower writer can commit a lower id after a faster one with a higher id was scanned.
  const t = await createTestApp();
  const { cookie } = await t.login('admin', 'admin-password-123');
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await t.request(path, {
      method,
      headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return (await res.json()) as Record<string, unknown>;
  };
  await call('POST', '/system/automations/rules', {
    name: 'Eventos',
    module: 'Eventos',
    actions: ['CREATE'],
    steps: [{ kind: 'notify', title: 'Evento {id}' }],
  });
  await call('POST', '/system/automations/tick', {});
  const [{ base } = { base: 0 }] = await t.sql.query<{ base: number }>(
    'SELECT coalesce(max(id), 0)::int AS base FROM audit',
  );
  const commitAudit = (id: number, recordId: string) =>
    t.sql.query(
      `INSERT INTO audit (id, tenant_id, ts, module, record_id, action, detail)
       OVERRIDING SYSTEM VALUE VALUES ($1, $2, $3, 'Eventos', $4, 'CREATE', 'Sintético')`,
      [id, TENANT, t.clock.now(), recordId],
    );
  const titles = async () =>
    ((await call('GET', '/system/notifications')).items as { title: string }[])
      .map((n) => n.title)
      .sort();

  await commitAudit(base + 100, 'EV-FAST');
  await call('POST', '/system/automations/tick', {});
  t.clock.advance(1);
  await commitAudit(base + 50, 'EV-SLOW');
  await call('POST', '/system/automations/tick', {});
  expect(await titles()).toEqual(['Evento EV-FAST', 'Evento EV-SLOW']);
  const cursorAt = async () =>
    (
      await t.sql.query<{ last_audit_id: number }>(
        'SELECT last_audit_id FROM automation_cursors WHERE tenant_id = $1',
        [TENANT],
      )
    )[0]?.last_audit_id;
  // While the events are inside the settle window the cursor holds back.
  expect(await cursorAt()).toBeLessThan(base + 50);

  // Once both settle the cursor moves past them, and nothing is notified twice.
  t.clock.advance(120);
  await call('POST', '/system/automations/tick', {});
  await call('POST', '/system/automations/tick', {});
  expect(await titles()).toEqual(['Evento EV-FAST', 'Evento EV-SLOW']);
  expect(await cursorAt()).toBe(base + 100);
});
