import { describe, expect, it } from 'vitest';
import {
  foldText,
  matchExcerpt,
  searchTerms,
  toPrefixQuery,
} from '../../src/contexts/ontology/domain/search.ts';
import { createTestApp } from '../support/test-app.ts';

type Hit = { module: string; id: string; title: string; match: { field: string } | null };

describe('search terms', () => {
  it('folds accents, drops noise and builds a prefix query', () => {
    expect(foldText('Acción ÑANDÚ')).toBe('accion nandu');
    expect(searchTerms('  Comunidad, comunidad & a "agua"!  ')).toEqual(['comunidad', 'agua']);
    expect(toPrefixQuery(searchTerms('Comun agu'))).toBe('comun:* & agu:*');
    expect(toPrefixQuery(searchTerms(" ' : & ! "))).toBeNull();
    expect(
      searchTerms('a b c d e f g h i j k l m n o p q r s t u'.replace(/ /g, 'x ')),
    ).toHaveLength(8);
  });

  it('excerpts the first matching field, preferring the title', () => {
    expect(
      matchExcerpt(
        { Tema: 'Agua', Descripcion: 'Falta de agua potable' },
        ['agua'],
        ['Descripcion'],
      ),
    ).toEqual({ field: 'Descripcion', excerpt: 'Falta de agua potable' });
    expect(matchExcerpt({ Tema: 'Agua' }, ['luz'], [])).toBeNull();
  });
});

describe('GET /system/search', () => {
  const setup = async () => {
    const t = await createTestApp();
    const admin = await t.login('admin', 'admin-password-123');
    const post = (module: string, payload: Record<string, unknown>) =>
      t.request(`/api/${module}`, {
        method: 'POST',
        headers: { cookie: admin.cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ payload }),
      });
    const search = async (query: string, cookie = admin.cookie) => {
      const res = await t.request(`/system/search?${query}`, { headers: { cookie } });
      return { status: res.status, body: (await res.json()) as { query: string; hits: Hit[] } };
    };
    await post('actores', {
      ID_Actor: 'A-1',
      'Nombre_Actor/Organizacion': 'Comunidad Campesina Norte',
    });
    await post('demandas', {
      ID_Demanda: 'D-1',
      Descripcion: 'Acceso a agua potable',
      Tema: 'Agua',
    });
    await post('eventos', {
      ID_Evento: 'EV-1',
      Descripcion_Hecho: 'Acción de protesta por el agua',
    });
    return { t, admin, search };
  };

  it('finds records across types by accent-insensitive prefixes', async () => {
    const { search } = await setup();
    const water = await search('q=AGU');
    expect(water.status).toBe(200);
    expect(water.body.hits.map((h) => h.id).sort()).toEqual(['D-1', 'EV-1']);
    const action = await search('q=accion%20prot');
    expect(action.body.hits).toMatchObject([
      { module: 'eventos', id: 'EV-1', title: 'Acción de protesta por el agua' },
    ]);
    expect(action.body.hits[0]?.match).toEqual({
      field: 'Descripcion_Hecho',
      excerpt: 'Acción de protesta por el agua',
    });
    expect((await search('q=comun')).body.hits.map((h) => h.id)).toEqual(['A-1']);
    expect((await search('q=A-1')).body.hits.map((h) => h.id)).toEqual(['A-1']);
  });

  it('filters by object type, bounds the limit and ignores empty queries', async () => {
    const { search } = await setup();
    expect((await search('q=agua&modules=demandas')).body.hits.map((h) => h.id)).toEqual(['D-1']);
    expect((await search('q=agua&limit=1')).body.hits).toHaveLength(1);
    expect((await search('q=%20%26%20')).body.hits).toEqual([]);
    expect((await search('q=agua&modules=planetas')).body.hits).toEqual([]);
    expect((await search('q=agua&limit=x')).status).toBe(422);
  });

  it('never returns another tenant’s records', async () => {
    const { t, admin } = await setup();
    await t.createScope(admin.cookie, {
      company_id: 'OTRA',
      project_id: 'PRJ-B',
      label: 'Otra',
      username: 'admin',
    });
    const res = await t.request('/system/search?q=agua', {
      headers: { cookie: admin.cookie, 'x-mascli-scope': 'OTRA/PRJ-B' },
    });
    expect(((await res.json()) as { hits: Hit[] }).hits).toEqual([]);
  });
});
