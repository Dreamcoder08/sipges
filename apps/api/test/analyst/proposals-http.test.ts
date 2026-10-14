import { describe, expect, it } from 'vitest';
import { findMention, suggestedLink } from '../../src/contexts/ontology/domain/mentions.ts';
import { createTestApp } from '../support/test-app.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

const setup = async () => {
  const t = await createTestApp();
  const admin = await t.login('admin', 'admin-password-123');
  const call = async (method: string, path: string, body?: unknown, cookie = admin.cookie) => {
    const res = await t.request(path, {
      method,
      headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: (await res.json()) as Json };
  };
  await call('POST', '/api/actores', {
    payload: { ID_Actor: 'A-1', 'Nombre_Actor/Organizacion': 'Comunidad Peñas Altas' },
  });
  await call('POST', '/api/eventos', {
    payload: {
      ID_Evento: 'EV-1',
      Descripcion_Hecho: 'Asamblea de la comunidad peñas altas sobre el agua sintética',
      Fecha: '2026-10-01',
    },
  });
  await call('POST', '/api/alertas', {
    payload: { ID_Alerta: 'AL-1', Causa: 'Bloqueo sintético', Nivel_Preliminar: 'Alto' },
  });
  return { ...t, admin, call };
};

const proposals = (t: Awaited<ReturnType<typeof setup>>, module: string, id: string) =>
  t.call('GET', `/system/briefing/proposals?module=${module}&id=${id}`);

describe('analyst proposals', () => {
  it('proposes a link from a text mention and creates it on approval', async () => {
    const t = await setup();
    const fromEvent = await proposals(t, 'eventos', 'EV-1');
    expect(fromEvent.body).toEqual([
      expect.objectContaining({
        kind: 'link',
        fingerprint: 'link:participa_en:actores/A-1:eventos/EV-1',
        link: {
          link_type: 'participa_en',
          source: { module: 'actores', id: 'A-1' },
          target: { module: 'eventos', id: 'EV-1' },
        },
      }),
    ]);
    expect(fromEvent.body[0].reason).toContain('peñas altas');
    // The actor side sees the same proposal, read from the event's text.
    expect((await proposals(t, 'actores', 'A-1')).body[0].fingerprint).toBe(
      fromEvent.body[0].fingerprint,
    );

    const approved = await t.call('POST', '/system/briefing/proposals', {
      module: 'eventos',
      id: 'EV-1',
      fingerprint: fromEvent.body[0].fingerprint,
      decision: 'approve',
    });
    expect(approved).toEqual({ status: 200, body: { ok: true, result: null } });
    const links = await t.call('GET', '/system/links?module=eventos&id=EV-1');
    expect(JSON.stringify(links.body)).toContain('Propuesta del analista aprobada');
    expect((await proposals(t, 'eventos', 'EV-1')).body).toEqual([]);
    const again = await t.call('POST', '/system/briefing/proposals', {
      module: 'eventos',
      id: 'EV-1',
      fingerprint: fromEvent.body[0].fingerprint,
      decision: 'approve',
    });
    expect(again.status).toBe(404);
  });

  it('proposes a follow-up action for a severe open alert, audited when decided', async () => {
    const t = await setup();
    const open = await proposals(t, 'alertas', 'AL-1');
    expect(open.body).toEqual([
      expect.objectContaining({
        kind: 'record',
        record: {
          module: 'acciones',
          payload: expect.objectContaining({ Alerta_Asociada: 'AL-1', Estado: 'Pendiente' }),
        },
      }),
    ]);
    const approved = await t.call('POST', '/system/briefing/proposals', {
      module: 'alertas',
      id: 'AL-1',
      fingerprint: open.body[0].fingerprint,
      decision: 'approve',
    });
    expect(approved.body.result).toMatch(/^acciones\//);
    // The new action links back by inference, so the alert is attended now.
    const briefing = await t.call('GET', '/system/briefing?module=alertas&id=AL-1');
    expect(JSON.stringify(briefing.body)).toContain('Atender alerta AL-1');
    const audit = await t.call('GET', '/system/audit?limit=10');
    expect((audit.body as unknown as Json[]).find((a) => a.module === 'Analista')).toMatchObject({
      action: 'REVIEW',
      record_id: 'AL-1',
    });
  });

  it('remembers a rejection and keeps consulta read-only', async () => {
    const t = await setup();
    const [first] = (await proposals(t, 'alertas', 'AL-1')).body as Json[];
    await t.createAccount(t.admin.cookie, {
      username: 'lectora',
      full_name: 'Lectora Demo',
      password: 'lectora-password-123',
      role: 'consulta',
    });
    const reader = await t.login('lectora', 'lectora-password-123');
    const denied = await t.call(
      'POST',
      '/system/briefing/proposals',
      { module: 'alertas', id: 'AL-1', fingerprint: first?.fingerprint, decision: 'reject' },
      reader.cookie,
    );
    expect(denied.status).toBe(403);
    const rejected = await t.call('POST', '/system/briefing/proposals', {
      module: 'alertas',
      id: 'AL-1',
      fingerprint: first?.fingerprint,
      decision: 'reject',
    });
    expect(rejected.body).toEqual({ ok: true, result: null });
    expect((await proposals(t, 'alertas', 'AL-1')).body).toEqual([]);
    expect((await t.call('GET', '/api/acciones')).body).toEqual([]);
    expect((await proposals(t, 'alertas', 'NADA')).status).toBe(404);
  });
});

describe('mention matching', () => {
  it('matches whole words without accents and skips short titles', () => {
    expect(findMention({ Nota: 'Reunión con Comunidad Peñas.' }, 'comunidad peñas')).toEqual({
      field: 'Nota',
      excerpt: 'Reunión con Comunidad Peñas.',
    });
    expect(findMention({ Nota: 'Comunidades Peñascales' }, 'Comunidad Peñas')).toBeNull();
    expect(findMention({ Nota: 'El río' }, 'río')).toBeNull();
    expect(findMention({ Nota: 'Código 12345' }, '12345')).toBeNull();
  });

  it('suggests the catalog link and never alliance or conflict', () => {
    expect(suggestedLink({ slug: 'eventos', id: 'E' }, { slug: 'actores', id: 'A' })).toEqual({
      linkType: 'participa_en',
      source: { slug: 'actores', id: 'A' },
      target: { slug: 'eventos', id: 'E' },
    });
    expect(suggestedLink({ slug: 'actores', id: 'A' }, { slug: 'actores', id: 'B' }).linkType).toBe(
      'relacionado_con',
    );
  });
});
