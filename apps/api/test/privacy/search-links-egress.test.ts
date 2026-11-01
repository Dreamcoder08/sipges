import { describe, expect, it } from 'vitest';
import { SECRETS, leaks, setupPrivacy } from './support.ts';

type Hit = { module: string; id: string; title: string | null };

describe('a restricted record asked for by id through get_links', () => {
  it('answers with a withheld stub and none of its links', async () => {
    const t = await setupPrivacy();
    await t.seed();
    await t.call('POST', '/api/actores', {
      payload: {
        ID_Actor: 'A-9',
        'Nombre_Actor/Organizacion': 'Frente Zeta-77',
        Tipo_Actor: 'Otro',
      },
    });
    await t.call('PUT', '/system/marking', {
      module: 'actores',
      id: 'A-9',
      marking: 'restringido',
    });
    await t.call('POST', '/system/links', {
      link_type: 'participa_en',
      source: { module: 'actores', id: 'A-9' },
      target: { module: 'eventos', id: 'EV-1' },
      note: '',
    });
    await t.setSwitch(true);
    const { token } = await t.key('Analista total', undefined, 'read', 'full');

    const out = await t.tool(token, 'get_links', { module: 'actores', id: 'A-9' });

    expect(out.isError).toBe(false);
    expect(out.structuredContent).toEqual({ module: 'actores', id: 'A-9', withheld: true });
    const [row] = await t.egressRows();
    expect(row?.detail).toContain('retenidos: actores/A-9');
  });
});

describe('search_records never reveals what a dropped field holds', () => {
  it.each([
    ['contra', 'a political stance'],
    ['sindicato', 'union membership'],
    ['diabetes', 'health data'],
    [SECRETS.complainant, 'the name of a complainant'],
  ])('a query for «%s» (%s) finds nothing', async (query) => {
    const t = await setupPrivacy();
    await t.seed();
    await t.setSwitch(true);
    const { token } = await t.key('Analista', undefined, 'read', 'limited');

    const out = await t.tool(token, 'search_records', { query });

    expect(out.isError).toBe(false);
    expect(out.structuredContent.hits).toEqual([]);
  });

  it.each([
    ['sechura diabetes', 'EV-1'],
    ['sechura contra', 'A-1'],
    ['sechura sindicato', 'A-1'],
    ['queja tapia', 'BZ-1'],
    ['queja diabetes', 'BZ-1'],
  ])(
    'a query pairing an allowed word with a dropped one («%s») does not find %s',
    async (query, id) => {
      const t = await setupPrivacy();
      await t.seed();
      await t.setSwitch(true);
      const { token } = await t.key('Analista', undefined, 'read', 'limited');

      const out = await t.tool(token, 'search_records', { query });

      expect(out.isError).toBe(false);
      expect(out.structuredContent.hits.map((h: Hit) => h.id)).not.toContain(id);
    },
  );

  it('still finds records through their allowed fields', async () => {
    const t = await setupPrivacy();
    await t.seed();
    await t.setSwitch(true);
    const { token } = await t.key('Analista', undefined, 'read', 'limited');

    const out = await t.tool(token, 'search_records', { query: 'asamblea' });

    expect(out.structuredContent.hits.map((h: Hit) => h.id)).toEqual(['EV-1']);
    expect(out.structuredContent.hits[0].match.field).toBeTruthy();
  });
});

describe('names SIPGES holds outside name fields are replaced in free text', () => {
  it('a complainant (Remitente) and dialogue participants never appear in clear', async () => {
    const t = await setupPrivacy();
    await t.seed();
    await t.call('POST', '/api/buzon', {
      payload: {
        ID_Caso: 'BZ-2',
        Fecha: '2026-10-03',
        Tipo: 'Queja',
        Asunto: 'Rosa Elena Tapia reclama por agua',
        Remitente: SECRETS.complainant,
      },
    });
    await t.call('POST', '/api/dialogos', {
      payload: {
        Proceso: 'Mesa con Juan Perez Quispe',
        Participantes: 'Juan Perez Quispe, Ana Lopez',
        Estado: 'Abierto',
      },
    });
    await t.setSwitch(true);
    const { token } = await t.key('Analista', undefined, 'read', 'limited');

    const timeline = JSON.stringify(
      await t.tool(token, 'get_timeline', { from: '2026-10', to: '2026-10' }),
    );
    const search = JSON.stringify(await t.tool(token, 'search_records', { query: 'Mesa' }));

    expect(timeline).toContain('BZ-2');
    expect(leaks(timeline)).toEqual([]);
    expect(search).toContain('Mesa con');
    expect(search).not.toMatch(/Perez|Quispe/);
  });
});
