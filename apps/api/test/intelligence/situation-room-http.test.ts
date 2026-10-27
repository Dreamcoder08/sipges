import { describe, expect, it } from 'vitest';
import { createTestApp } from '../support/test-app.ts';

const setup = async () => {
  const t = await createTestApp();
  const admin = await t.login('admin', 'admin-password-123');
  const call = (method: string, path: string, body?: unknown) =>
    t.request(path, {
      method,
      headers: {
        cookie: admin.cookie,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const json = async (res: Response) => (await res.json()) as Record<string, unknown>;
  const alertId = String(
    (
      await json(
        await call('POST', '/system/intelligence/territorial-alerts', {
          text: 'Convocatoria sintética a asamblea por agua limpia.',
          mode: 'rules',
        }),
      )
    ).id,
  );
  await call('PATCH', `/system/intelligence/territorial-alerts/${alertId}`, {
    status: 'Corroborado',
  });
  const plan = async (title: string, due: string) =>
    (
      (
        await json(
          await call('POST', '/system/prevention/actions', {
            alert_id: alertId,
            title,
            responsible: 'Equipo social',
            due_date: due,
          }),
        )
      ).action as { id: string }
    ).id;
  const patch = (id: string, body: Record<string, unknown>) =>
    call('PATCH', `/system/prevention/actions/${id}`, body);
  const room = async () => json(await call('GET', '/system/prevention/situation-room'));
  return { json, plan, patch, room };
};

describe('Situation room (MASCLI 4.0)', () => {
  it('shows what is blocked and by whom, what is overdue and what is moving', async () => {
    const { json, plan, patch, room } = await setup();
    const blocked = await plan('Mesa técnica sintética', '2026-12-01');
    const overdue = await plan('Visita de campo sintética', '2026-10-01');
    await plan('Monitoreo participativo sintético', '2026-12-15');

    const bad = await patch(blocked, { status: 'En ejecución', progress: 10, blocked_by: 'Nadie' });
    expect(bad.status).toBe(422);
    expect(await json(bad)).toEqual({ detail: 'Bloqueo no válido' });

    expect(
      (
        await patch(blocked, {
          status: 'En ejecución',
          progress: 10,
          blocked_by: 'Autoridad',
          blocked_reason: 'Espera de permiso municipal',
        })
      ).status,
    ).toBe(200);

    expect(await room()).toMatchObject({
      blocked: [
        {
          id: blocked,
          title: 'Mesa técnica sintética',
          responsible: 'Equipo social',
          blocked_by: 'Autoridad',
          blocked_reason: 'Espera de permiso municipal',
        },
      ],
      overdue: [{ id: overdue, due_date: '2026-10-01' }],
      moving: 1,
      blocked_by_count: { Autoridad: 1 },
    });

    // Clearing the blocker returns the plan to the moving list.
    await patch(blocked, { status: 'En ejecución', progress: 30, blocked_by: '' });
    expect(await room()).toMatchObject({ blocked: [], moving: 2 });
  });
});
