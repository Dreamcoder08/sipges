import { describe, expect, it } from 'vitest';
import { createTestApp } from '../support/test-app.ts';

const setup = async () => {
  const t = await createTestApp();
  const admin = await t.login('admin', 'admin-password-123');
  const call = (method: string, path: string, body?: unknown, cookie = admin.cookie) =>
    t.request(path, {
      method,
      headers: {
        cookie,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const json = async (res: Response) => (await res.json()) as Record<string, unknown>;
  const coordinator = async (username: string) => {
    await t.createAccount(admin.cookie, {
      username,
      full_name: 'Synthetic',
      password: 'synthetic-pass-123',
      role: 'coordinador',
    });
    await t.grant(admin.cookie, username);
    return (await t.login(username, 'synthetic-pass-123')).cookie;
  };
  const alert = async (level: 'Alta' | 'Media') => {
    const created = await json(
      await call('POST', '/system/intelligence/territorial-alerts', {
        text: 'Convocatoria sintética a asamblea por agua limpia.',
        mode: 'rules',
      }),
    );
    const id = String(created.id);
    await t.sql.query('UPDATE digital_alert_reviews SET level = $2 WHERE id = $1', [id, level]);
    return id;
  };
  const decide = (id: string, status: string, cookie: string) =>
    call('PATCH', `/system/intelligence/territorial-alerts/${id}`, { status }, cookie);
  const read = async (id: string) =>
    json(await call('GET', `/system/intelligence/territorial-alerts/${id}`));
  return { t, json, coordinator, alert, decide, read };
};

describe('Four eyes on high-priority alerts (SIPGES)', () => {
  it('needs a second, different person to corroborate a high-priority alert', async () => {
    const { json, alert, coordinator, decide, read } = await setup();
    const ana = await coordinator('ana');
    const luis = await coordinator('luis');
    const id = await alert('Alta');

    const first = await decide(id, 'Corroborado', ana);
    expect(first.status).toBe(200);
    expect(await json(first)).toMatchObject({
      status: 'Pendiente de verificación',
      second_validation_required: true,
    });
    expect(await read(id)).toMatchObject({
      status: 'Pendiente de verificación',
      first_validator: 'ana',
    });

    const again = await decide(id, 'En seguimiento', ana);
    expect(again.status).toBe(409);
    expect(await json(again)).toEqual({
      detail: 'Otra persona debe confirmar la validación de una alerta de prioridad Alta',
    });

    const second = await decide(id, 'Corroborado', luis);
    expect(await json(second)).toMatchObject({
      status: 'Corroborado',
      second_validation_required: false,
    });
    expect(await read(id)).toMatchObject({ status: 'Corroborado', first_validator: 'ana' });
  });

  it('leaves medium alerts and discarding to one person', async () => {
    const { alert, coordinator, decide, read } = await setup();
    const ana = await coordinator('ana');
    const media = await alert('Media');
    expect((await decide(media, 'Corroborado', ana)).status).toBe(200);
    expect(await read(media)).toMatchObject({ status: 'Corroborado' });
    const alta = await alert('Alta');
    expect((await decide(alta, 'Descartado', ana)).status).toBe(200);
    expect(await read(alta)).toMatchObject({ status: 'Descartado' });
  });
});
