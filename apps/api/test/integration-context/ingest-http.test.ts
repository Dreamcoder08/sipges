import { describe, expect, it } from 'vitest';
import { formPayload, ingestPayloads } from '../../src/contexts/integration/application/index.ts';
import { createTestApp } from '../support/test-app.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

const setup = async () => {
  const t = await createTestApp();
  const admin = await t.login('admin', 'admin-password-123');
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await t.request(path, {
      method,
      headers: {
        cookie: admin.cookie,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: (await res.json()) as Json };
  };
  const key = async (name: string, access = 'write') =>
    (await call('POST', '/system/integrations/api-keys', { name, access, clearance: 'limited' }))
      .body.token as string;
  const ingest = async (
    token: string,
    module: string,
    body: unknown,
    headers: Record<string, string> = {},
  ) => {
    const res = await t.request(`/hooks/ingest/${module}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
    return { status: res.status, headers: res.headers, body: (await res.json()) as Json };
  };
  return { ...t, call, key, ingest };
};

describe('inbound webhooks', () => {
  it('creates records as the key, one CREATE each, so automation rules react', async () => {
    const t = await setup();
    await t.call('POST', '/system/automations/rules', {
      name: 'Alertas altas',
      module: 'Alertas',
      actions: ['CREATE'],
      conditions: [{ field: 'Nivel', op: 'eq', value: 'Alto' }],
      steps: [{ kind: 'notify', title: 'Alerta {id}' }],
    });
    const token = await t.key('Formulario de campo');
    const one = await t.ingest(token, 'alertas', { ID_Alerta: 'AL-9', Nivel: 'Alto' });
    expect(one).toMatchObject({
      status: 201,
      body: { ok: true, module: 'alertas', ids: ['AL-9'] },
    });
    const many = await t.ingest(token, 'alertas', {
      records: [
        { ID_Alerta: 'AL-10', Nivel: 'Alto' },
        { ID_Alerta: 'AL-11', Nivel: 'Bajo' },
      ],
    });
    expect(many.body.ids).toEqual(['AL-10', 'AL-11']);
    const history = await t.call('GET', '/api/alertas/AL-10/history');
    expect(history.body[0]).toMatchObject({ actor: 'api:Formulario de campo' });

    expect((await t.call('POST', '/system/automations/tick', {})).body).toMatchObject({
      queued: 2,
      delivered: 2,
    });
  });

  it('accepts a plain form post', async () => {
    const t = await setup();
    const token = await t.key('Formulario web');
    const res = await t.request('/hooks/ingest/demandas', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ ID_Demanda: 'D-5', Demanda: 'Agua sintética' }).toString(),
    });
    expect(res.status).toBe(201);
    const stored = await t.call('GET', '/api/demandas/D-5');
    expect(JSON.stringify(stored.body)).toContain('Agua sintética');
  });

  it('replays a retried call with the same Idempotency-Key instead of duplicating', async () => {
    const t = await setup();
    const token = await t.key('Zapier');
    const headers = { 'idempotency-key': 'zap-123' };
    const first = await t.ingest(token, 'demandas', { Demanda: 'Sin id sintética' }, headers);
    expect(first.status).toBe(201);
    const again = await t.ingest(token, 'demandas', { Demanda: 'Sin id sintética' }, headers);
    expect(again.status).toBe(201);
    expect(again.body.ids).toEqual(first.body.ids);
    expect(again.headers.get('idempotent-replayed')).toBe('true');
    const list = await t.call('GET', '/api/demandas');
    expect((list.body as unknown as Json[]).length).toBe(1);

    // A rejected call is not remembered, so the corrected retry goes through.
    const bad = await t.ingest(token, 'demandas', [{ Proyecto_ID: 'OTRO' }], {
      'webhook-id': 'msg_1',
    });
    expect(bad).toMatchObject({ status: 403, body: { index: 0 } });
    const fixed = await t.ingest(token, 'demandas', [{ Demanda: 'Corregida' }], {
      'webhook-id': 'msg_1',
    });
    expect(fixed.status).toBe(201);
    expect(
      (await t.ingest(token, 'demandas', {}, { 'idempotency-key': 'con espacio' })).status,
    ).toBe(400);
  });

  it('refuses read keys, bad keys, unknown modules and bad bodies without writing', async () => {
    const t = await setup();
    const reader = await t.key('Lector', 'read');
    const writer = await t.key('Escritor');
    expect((await t.ingest(reader, 'demandas', { Demanda: 'x' })).status).toBe(403);
    expect((await t.ingest('mscli_000000000000_nope', 'demandas', { Demanda: 'x' })).status).toBe(
      401,
    );
    expect((await t.ingest(writer, 'inexistente', { a: 1 })).status).toBe(404);
    expect((await t.ingest(writer, 'demandas', '{roto')).status).toBe(400);
    const second = await t.ingest(writer, 'demandas', [{ Demanda: 'ok' }, 'texto']);
    expect(second).toMatchObject({ status: 422, body: { index: 1 } });
    const res = await t.request('/hooks/ingest/demandas', {
      method: 'POST',
      headers: { authorization: `Bearer ${writer}`, 'content-type': 'text/plain' },
      body: 'hola',
    });
    expect(res.status).toBe(415);
    expect((await t.call('GET', '/api/demandas')).body).toEqual([]);
  });
});

describe('ingest payload shapes', () => {
  it('accepts one object, an array or {records}, within limits', () => {
    expect(ingestPayloads({ a: 1 })).toEqual({ ok: true, payloads: [{ a: 1 }] });
    expect(ingestPayloads([{ a: 1 }, { b: 2 }])).toMatchObject({ ok: true });
    expect(ingestPayloads({ records: [{ a: 1 }] })).toEqual({ ok: true, payloads: [{ a: 1 }] });
    // A record that merely has a `records` field next to others is one record.
    expect(ingestPayloads({ records: [], x: 1 })).toMatchObject({ ok: true });
    expect(ingestPayloads([])).toMatchObject({ ok: false });
    expect(ingestPayloads(Array.from({ length: 51 }, () => ({ a: 1 })))).toMatchObject({
      ok: false,
    });
    expect(ingestPayloads([{}])).toMatchObject({ ok: false, problem: { index: 0 } });
    expect(ingestPayloads('x')).toMatchObject({ ok: false, problem: { index: 0 } });
    expect(formPayload({ a: 'x', file: new Blob(['y']) })).toEqual({ a: 'x' });
  });
});
