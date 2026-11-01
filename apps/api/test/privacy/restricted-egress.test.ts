import { describe, expect, it } from 'vitest';
import type { Narrator } from '../../src/contexts/analyst/application/index.ts';
import type { EmbeddingProvider } from '../../src/contexts/intelligence/application/index.ts';
import { PSEUDONYM, leaks, setupPrivacy } from './support.ts';

const SECRET_TEXT = 'Informe reservado Zeta-77';

type Fixture = Awaited<ReturnType<typeof setupPrivacy>>;

/** The seeded project plus a restricted actor and a restricted event linked to A-1. */
const withRestricted = async (t: Fixture) => {
  await t.seed();
  await t.call('POST', '/api/actores', {
    payload: { ID_Actor: 'A-9', 'Nombre_Actor/Organizacion': 'Frente Zeta-77', Tipo_Actor: 'Otro' },
  });
  await t.call('POST', '/api/eventos', {
    payload: { ID_Evento: 'EV-9', Fecha: '2026-10-05', Descripcion_Hecho: SECRET_TEXT },
  });
  await t.call('PUT', '/system/marking', { module: 'actores', id: 'A-9', marking: 'restringido' });
  await t.call('PUT', '/system/marking', { module: 'eventos', id: 'EV-9', marking: 'restringido' });
  await t.call('POST', '/system/links', {
    link_type: 'participa_en',
    source: { module: 'actores', id: 'A-1' },
    target: { module: 'eventos', id: 'EV-9' },
    note: '',
  });
  await t.setSwitch(true);
};

const hidden = (text: string) =>
  ['Zeta-77', 'A-9', 'EV-9'].filter((needle) => text.includes(needle));

describe('restricted records never leave (full-clearance key)', () => {
  it('MCP read tools omit them, say nothing about their content and still serve the rest', async () => {
    const t = await setupPrivacy();
    await withRestricted(t);
    const { token } = await t.key('Analista total', undefined, 'read', 'full');

    // Full clearance does see it in SIPGES itself; only the outside is closed.
    expect((await t.call('GET', '/api/eventos/EV-9')).status).toBe(200);

    const record = await t.tool(token, 'get_record', { module: 'eventos', id: 'EV-9' });
    expect(record.isError).toBe(false);
    expect(record.structuredContent).toEqual({ module: 'eventos', id: 'EV-9', withheld: true });
    expect(
      (await t.tool(token, 'get_record', { module: 'eventos', id: 'EV-1' })).structuredContent,
    ).toMatchObject({ id: 'EV-1', payload: { Fecha: '2026-10-01' } });

    const outputs = [
      await t.tool(token, 'search_records', { query: 'Zeta' }),
      await t.tool(token, 'search_records', { query: 'asamblea' }),
      await t.tool(token, 'get_links', { module: 'actores', id: 'A-1' }),
      await t.tool(token, 'get_timeline', { from: '2026-10', to: '2026-10' }),
      await t.tool(token, 'get_briefing', { module: 'actores', id: 'A-1' }),
      await t.tool(token, 'get_briefing', { module: 'eventos', id: 'EV-9' }),
    ];
    // Asking for a restricted record by id gets only a «withheld» stub, no content.
    expect(outputs[5]?.structuredContent).toEqual({
      module: 'eventos',
      id: 'EV-9',
      withheld: true,
    });
    for (const out of outputs.slice(0, 5)) expect(hidden(JSON.stringify(out))).toEqual([]);
    expect(outputs[0]?.structuredContent.hits).toEqual([]);
    expect(outputs[1]?.structuredContent.hits.map((h: { id: string }) => h.id)).toEqual(['EV-1']);
    const links = outputs[2]?.structuredContent.links.map(
      (l: { other: { id: string } }) => l.other.id,
    );
    expect(links).toEqual(['EV-1', 'C-1']);
    expect(outputs[3]?.structuredContent.entries.map((e: { id: string }) => e.id)).toEqual([
      'BZ-1',
      'EV-1',
    ]);
  });

  it('counts them as dropped in the audit entry and lists their ids as withheld, without values', async () => {
    const t = await setupPrivacy();
    await withRestricted(t);
    const { token } = await t.key('Analista total', undefined, 'read', 'full');
    await t.tool(token, 'get_record', { module: 'eventos', id: 'EV-9' });
    await t.tool(token, 'get_links', { module: 'actores', id: 'A-1' });
    const rows = await t.egressRows();
    const [links, record] = rows as [Record<string, string>, Record<string, string>];
    expect(record.detail).toContain('retenidos: eventos/EV-9');
    expect(record.detail).toMatch(/descartados: [1-9]/);
    expect(links.detail).toContain('retenidos: eventos/EV-9');
    for (const row of rows) {
      expect(row.detail).not.toContain('Zeta-77');
      expect(leaks(JSON.stringify(row))).toEqual([]);
    }
  });

  it('keeps them out of the narrator prompt and logs them as withheld', async () => {
    const seen: string[] = [];
    const narrator: Narrator = {
      name: 'prueba',
      narrate: async (briefing) => {
        seen.push(briefing);
        return 'Se registró un evento [1].';
      },
    };
    const t = await setupPrivacy({ narrator });
    await withRestricted(t);
    const { body } = await t.call('GET', '/system/briefing?module=actores&id=A-1');
    expect(body).toMatchObject({ engine: 'asistido' });
    expect(seen).toHaveLength(1);
    expect(hidden(seen[0] ?? '')).toEqual([]);
    expect(seen[0]).toMatch(PSEUDONYM);
    const [row] = await t.egressRows();
    expect(row?.detail).toContain('retenidos: eventos/EV-9');
  });

  it('keeps them out of what an external embeddings service receives', async () => {
    const sent: string[] = [];
    const embeddings: EmbeddingProvider = {
      model: 'toy',
      egress: 'external',
      embed: async (text) => {
        sent.push(text);
        return [1, 0, 0, 0, 0, 0, 0, 0.1];
      },
    };
    const t = await setupPrivacy({ env: { SIPGES_SEMANTIC_SEARCH: '1' }, embeddings });
    await withRestricted(t);
    await t.call('GET', '/system/search?q=asamblea');
    expect(sent.length).toBeGreaterThan(1);
    expect(sent.filter((text) => hidden(text).length)).toEqual([]);
  });
});
