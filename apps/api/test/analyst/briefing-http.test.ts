import { describe, expect, it } from 'vitest';
import type { Narrator } from '../../src/contexts/analyst/application/index.ts';
import { createTestApp } from '../support/test-app.ts';

type Json = Record<string, unknown>;

const setup = async (narrator: Narrator | null = null, externalAi = false) => {
  const t = await createTestApp({}, { narrator });
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
  await call('POST', '/api/actores', {
    payload: {
      ID_Actor: 'A-1',
      'Nombre_Actor/Organizacion': 'Comunidad Norte',
      Posicion_Proyecto: 'En contra',
    },
  });
  await call('POST', '/api/fuentes', {
    payload: { ID_Fuente: 'F-1', Archivo_Fuente: 'Acta pública' },
  });
  await call('POST', '/api/fuentes', {
    payload: { ID_Fuente: 'F-2', Archivo_Fuente: 'Informe reservado' },
  });
  await call('POST', '/api/eventos', {
    payload: {
      ID_Evento: 'EV-1',
      Descripcion_Hecho: 'Asamblea comunal',
      Fecha: '2026-10-01',
      Actor_Principal: 'Comunidad Norte',
      Fuente_ID: 'F-1',
    },
  });
  await call('POST', '/system/links', {
    link_type: 'relacionado_con',
    source: { module: 'actores', id: 'A-1' },
    target: { module: 'fuentes', id: 'F-2' },
    note: '',
  });
  await call('PUT', '/system/marking', { module: 'fuentes', id: 'F-2', marking: 'restringido' });
  // The narrator is external AI: it only runs once the project switched it on (ADR 0030).
  if (externalAi) await call('PUT', '/system/v4/settings', { external_ai: { enabled: true } });
  return { call };
};

const recording = (answer: (briefing: string) => string) => {
  const seen: string[] = [];
  const narrator: Narrator = {
    name: 'prueba',
    narrate: async (briefing) => {
      seen.push(briefing);
      return answer(briefing);
    },
  };
  return { narrator, seen };
};

describe('GET /system/briefing', () => {
  it('returns a cited extractive briefing without a narrator', async () => {
    const { call } = await setup();
    const { status, body } = await call('GET', '/system/briefing?module=actores&id=A-1');
    expect(status).toBe(200);
    expect(body).toMatchObject({
      subject: { module: 'actores', id: 'A-1', title: 'Comunidad Norte' },
      generated_at: '2026-10-12T12:00:00Z',
      engine: 'extractivo',
      narrator: null,
      notice: null,
      narrative: null,
    });
    const sources = body['sources'] as Json[];
    expect(sources.map((s) => `${s['ref']}:${s['module']}/${s['id']}`)).toEqual([
      '1:actores/A-1',
      '2:fuentes/F-2',
      '3:eventos/EV-1',
    ]);
    const sections = body['sections'] as { title: string; sentences: Json[] }[];
    expect(sections.map((s) => s.title)).toEqual([
      'Resumen',
      'Red de vínculos',
      'Cronología',
      'Señales de atención',
    ]);
    expect(sections[3]?.sentences.map((s) => s['text'])).toEqual([
      'Actor «Comunidad Norte» mantiene una posición En contra.',
      '1 vínculo apunta a información restringida.',
    ]);
    expect((await call('GET', '/system/briefing?module=actores&id=NOPE')).status).toBe(404);
    expect((await call('GET', '/system/briefing?module=nada&id=A-1')).status).toBe(404);
  });

  it('adds a narrative that cites the briefing and never shows the model restricted records', async () => {
    const { narrator, seen } = recording(
      (text) =>
        `La comunidad [1] se opone y participó en la asamblea [${text.includes('[2] Evento') ? 2 : 9}].`,
    );
    const { call } = await setup(narrator, true);
    const { body } = await call('GET', '/system/briefing?module=actores&id=A-1');
    expect(seen).toHaveLength(1);
    // The model sees the actor as a pseudonym, never by name, and not its stance either.
    expect(seen[0]).not.toContain('Comunidad Norte');
    expect(seen[0]).toMatch(/Actor «Actor-[0-9A-F]{6}»/);
    expect(seen[0]).not.toContain('En contra');
    expect(seen[0]).not.toContain('Informe reservado');
    expect(seen[0]).not.toContain('restringida');
    expect(body).toMatchObject({
      engine: 'asistido',
      narrator: 'prueba',
      notice: null,
      narrative: {
        // The model saw the event as [2]; without the restricted source it is [3] for the reader.
        text: 'La comunidad [1] se opone y participó en la asamblea [3].',
        refs: [1, 3],
      },
    });
  });

  it('falls back to the extractive briefing when the narrator fails or cites unknown sources', async () => {
    for (const answer of [
      () => {
        throw new Error('sin conexión');
      },
      () => 'Afirmación sin fuente.',
      () => 'Dato inventado [7].',
    ]) {
      const { call } = await setup(recording(answer).narrator, true);
      const { body } = await call('GET', '/system/briefing?module=actores&id=A-1');
      expect(body).toMatchObject({
        engine: 'extractivo',
        narrator: null,
        narrative: null,
        notice: 'El resumen asistido no estuvo disponible; se muestra el informe extractivo.',
      });
    }
  });

  it('does not send restricted records to the narrator', async () => {
    const { narrator, seen } = recording(() => 'Texto [1].');
    const { call } = await setup(narrator);
    const { body } = await call('GET', '/system/briefing?module=fuentes&id=F-2');
    expect(seen).toEqual([]);
    expect(body).toMatchObject({
      engine: 'extractivo',
      notice: expect.stringContaining('restringido'),
    });
  });
});
