import { LinkEdge } from '@mascli/contracts';
import { describe, expect, it } from 'vitest';
import { createTestApp } from '../support/test-app.ts';

type Json = Record<string, unknown>;

const setup = async () => {
  const t = await createTestApp();
  const admin = await t.login('admin', 'admin-password-123');
  const call = async (method: string, path: string, body?: unknown, cookie = admin.cookie) => {
    const res = await t.request(path, {
      method,
      headers: {
        cookie,
        'x-mascli-scope': 'MASCLI/PRJ-SECHURA',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: (await res.json()) as Json };
  };
  const create = async (module: string, payload: Json) => {
    const res = await call('POST', `/api/${module}`, { payload });
    expect(res.status).toBe(200);
    return res.body['id'] as string;
  };
  const link = (link_type: string, source: [string, string], target: [string, string], note = '') =>
    call('POST', '/system/links', {
      link_type,
      source: { module: source[0], id: source[1] },
      target: { module: target[0], id: target[1] },
      note,
    });
  return { t, admin, call, create, link };
};

const seed = async (s: Awaited<ReturnType<typeof setup>>) => {
  await s.create('actores', { ID_Actor: 'A-1', 'Nombre_Actor/Organizacion': 'Comunidad Norte' });
  await s.create('actores', { ID_Actor: 'A-2', 'Nombre_Actor/Organizacion': 'Frente Sur' });
  await s.create('fuentes', { ID_Fuente: 'F-1', Archivo_Fuente: 'Acta de asamblea' });
  await s.create('eventos', {
    ID_Evento: 'EV-1',
    Descripcion_Hecho: 'Asamblea comunal',
    Fecha: '2026-10-01',
    Actor_Principal: '  comunidad norte ',
    Fuente_ID: 'F-1',
  });
  await s.create('demandas', { ID_Demanda: 'D-1', Descripcion: 'Agua potable' });
};

describe('ontology catalog and typed links', () => {
  it('defaults historical relationship payloads to undocumented evidence', () => {
    const edge = LinkEdge.parse({
      id: 1,
      link_type: 'plantea',
      source: { module: 'actores', id: 'A-1' },
      target: { module: 'demandas', id: 'D-1' },
      inferred: false,
      via: null,
      note: '',
      created_by: 'admin',
      created_at: null,
    });
    expect(edge.evidence).toBeNull();
    expect(edge.evidence_status).toBe('undocumented');
  });

  it('serves the catalog', async () => {
    const { call } = await setup();
    const { status, body } = await call('GET', '/system/ontology');
    expect(status).toBe(200);
    const types = body['object_types'] as Json[];
    expect(types.find((t) => t['module'] === 'actores')).toMatchObject({
      label: 'Actor',
      title_field: 'Nombre_Actor/Organizacion',
    });
    expect((body['link_types'] as Json[]).map((t) => t['id'])).toContain('participa_en');
  });

  it('creates, lists from both ends, and deletes explicit links with audit', async () => {
    const s = await setup();
    await seed(s);
    const created = await s.link('plantea', ['actores', 'A-2'], ['demandas', 'D-1'], 'Mesa 1');
    expect(created).toEqual({ status: 200, body: { ok: true, id: expect.any(Number) } });

    const fromActor = await s.call('GET', '/system/links?module=actores&id=A-2');
    expect(fromActor.status).toBe(200);
    expect(fromActor.body['record']).toMatchObject({ module: 'actores', title: 'Frente Sur' });
    expect(fromActor.body['links']).toEqual([
      {
        edge: {
          id: created.body['id'],
          link_type: 'plantea',
          source: { module: 'actores', id: 'A-2' },
          target: { module: 'demandas', id: 'D-1' },
          inferred: false,
          via: null,
          note: 'Mesa 1',
          created_by: 'admin',
          created_at: '2026-10-12T12:00:00Z',
          evidence: null,
          evidence_status: 'undocumented',
        },
        direction: 'out',
        label: 'plantea',
        other: expect.objectContaining({ module: 'demandas', id: 'D-1', title: 'Agua potable' }),
      },
    ]);
    const fromDemand = await s.call('GET', '/system/links?module=demandas&id=D-1');
    expect(fromDemand.body['links']).toMatchObject([
      { direction: 'in', label: 'es planteada por', other: { id: 'A-2' } },
    ]);

    expect((await s.link('plantea', ['actores', 'A-2'], ['demandas', 'D-1'])).status).toBe(409);
    expect((await s.call('DELETE', `/system/links/${created.body['id']}`)).status).toBe(200);
    expect((await s.call('DELETE', `/system/links/${created.body['id']}`)).status).toBe(404);
    expect((await s.call('GET', '/system/links?module=demandas&id=D-1')).body['links']).toEqual([]);

    const audit = (await s.call('GET', '/system/audit')).body as unknown as Json[];
    expect(audit.filter((row) => row['module'] === 'Vinculos').map((r) => r['action'])).toEqual([
      'DELETE',
      'CREATE',
    ]);
  });

  it('attaches and clears real source evidence with audit, rejecting missing sources atomically', async () => {
    const s = await setup();
    await seed(s);
    const input = {
      link_type: 'plantea',
      source: { module: 'actores', id: 'A-2' },
      target: { module: 'demandas', id: 'D-1' },
      evidence: { module: 'fuentes', id: 'missing' },
    };
    expect((await s.call('POST', '/system/links', input)).status).toBe(404);
    expect((await s.call('GET', '/system/links?module=actores&id=A-2')).body['links']).toEqual([]);
    const created = await s.call('POST', '/system/links', {
      ...input,
      evidence: { module: 'fuentes', id: 'F-1' },
    });
    expect(created.status).toBe(200);
    const path = `/system/links/${created.body['id']}/evidence`;
    const list = async () =>
      (await s.call('GET', '/system/links?module=actores&id=A-2')).body['links'];
    expect(await list()).toMatchObject([
      {
        edge: {
          evidence_status: 'available',
          evidence: { module: 'fuentes', id: 'F-1', title: 'Acta de asamblea' },
        },
      },
    ]);
    expect(
      (await s.call('PUT', path, { evidence: { module: 'fuentes', id: 'missing' } })).status,
    ).toBe(404);
    expect(await list()).toMatchObject([{ edge: { evidence_status: 'available' } }]);
    expect((await s.call('PUT', path, { evidence: { module: 'actores', id: 'A-1' } })).status).toBe(
      422,
    );
    expect((await s.call('PUT', path, { evidence: null })).status).toBe(200);
    expect(await list()).toMatchObject([
      { edge: { evidence: null, evidence_status: 'undocumented' } },
    ]);
    expect((await s.call('PUT', path, { evidence: { module: 'fuentes', id: 'F-1' } })).status).toBe(
      200,
    );
    await s.call('DELETE', '/api/fuentes/F-1');
    expect(await list()).toMatchObject([
      { edge: { evidence: null, evidence_status: 'unavailable' } },
    ]);
    const audit = (await s.call('GET', '/system/audit')).body as unknown as Json[];
    expect(audit.filter((row) => row['module'] === 'Vinculos').map((row) => row['action'])).toEqual(
      ['UPDATE', 'UPDATE', 'CREATE'],
    );
  });

  it('retains private append-only source history across replacement, clear and link deletion', async () => {
    const s = await setup();
    await seed(s);
    await s.create('fuentes', { ID_Fuente: 'F-2', Archivo_Fuente: 'Second synthetic source' });
    const created = await s.call('POST', '/system/links', {
      link_type: 'plantea',
      source: { module: 'actores', id: 'A-2' },
      target: { module: 'demandas', id: 'D-1' },
      evidence: { module: 'fuentes', id: 'F-1' },
    });
    expect(created.status).toBe(200);
    const id = created.body['id'];
    const path = `/system/links/${id}/evidence`;
    // Only this synthetic test's privileged database connection may recover forensic ids.
    const history = () =>
      s.t.sql.query<{
        previous_source_id: string | null;
        next_source_id: string | null;
        actor: string;
        at: Date | string;
      }>(
        'SELECT previous_source_id, next_source_id, actor, at FROM link_evidence_history WHERE link_id = $1 ORDER BY id',
        [id],
      );
    expect((await s.call('PUT', path, { evidence: { module: 'fuentes', id: 'F-1' } })).status).toBe(
      200,
    );
    expect(
      (await s.call('PUT', path, { evidence: { module: 'fuentes', id: 'absent' } })).status,
    ).toBe(404);
    expect(await history()).toHaveLength(1);
    await s.t.createAccount(s.admin.cookie, {
      username: 'history-reader',
      full_name: 'Reader',
      password: 'reader-password-123',
      role: 'consulta',
    });
    await s.t.grant(s.admin.cookie, 'history-reader');
    const reader = await s.t.login('history-reader', 'reader-password-123');
    expect((await s.call('PUT', path, { evidence: null }, reader.cookie)).status).toBe(403);
    expect(await history()).toHaveLength(1);
    s.t.clock.advance(1);
    expect((await s.call('PUT', path, { evidence: { module: 'fuentes', id: 'F-2' } })).status).toBe(
      200,
    );
    s.t.clock.advance(1);
    expect((await s.call('PUT', path, { evidence: null })).status).toBe(200);
    expect((await s.call('PUT', path, { evidence: null })).status).toBe(200);
    expect((await s.call('DELETE', `/system/links/${id}`)).status).toBe(200);
    const retained = await history();
    expect(
      retained.map((row) => [
        row.previous_source_id,
        row.next_source_id,
        row.actor,
        new Date(row.at).toISOString(),
      ]),
    ).toEqual([
      [null, 'F-1', 'admin', '2026-10-12T12:00:00.000Z'],
      ['F-1', 'F-2', 'admin', '2026-10-12T12:00:01.000Z'],
      ['F-2', null, 'admin', '2026-10-12T12:00:02.000Z'],
    ]);
    const [permissions] = await s.t.sql.query<{
      can_insert: boolean;
      can_read: boolean;
      can_update: boolean;
      can_delete: boolean;
      forced: boolean;
    }>(
      `SELECT has_table_privilege('mascli_tenant', 'link_evidence_history', 'INSERT') AS can_insert,
        has_table_privilege('mascli_tenant', 'link_evidence_history', 'SELECT') AS can_read,
        has_table_privilege('mascli_tenant', 'link_evidence_history', 'UPDATE') AS can_update,
        has_table_privilege('mascli_tenant', 'link_evidence_history', 'DELETE') AS can_delete,
        relrowsecurity AND relforcerowsecurity AS forced FROM pg_class WHERE relname = 'link_evidence_history'`,
    );
    expect(permissions).toEqual({
      can_insert: true,
      can_read: false,
      can_update: false,
      can_delete: false,
      forced: true,
    });
    await expect(
      s.t.sql.transaction(async (tx) => {
        await tx.query(
          "SELECT set_config('app.tenant_id', 'MASCLI/PRJ-SECHURA', true), set_config('app.actor', 'admin', true)",
        );
        await tx.exec('SET LOCAL ROLE mascli_tenant');
        await tx.query(
          "INSERT INTO link_evidence_history (tenant_id, link_id, previous_source_id, next_source_id, actor, at) VALUES ('OTHER/TENANT', $1, NULL, NULL, 'admin', $2)",
          [id, s.t.clock.now()],
        );
      }),
    ).rejects.toThrow(/row-level security/);
    expect(await history()).toHaveLength(3);
    await expect(
      s.t.sql.transaction(async (tx) => {
        await tx.query("SELECT set_config('app.tenant_id', 'MASCLI/PRJ-SECHURA', true)");
        await tx.exec('SET LOCAL ROLE mascli_tenant');
        await tx.query('SELECT * FROM link_evidence_history');
      }),
    ).rejects.toThrow(/permission denied/);
    // Model a managed-Postgres owner without superuser or BYPASSRLS privileges.
    await s.t.sql.transaction(async (tx) => {
      await tx.exec('CREATE ROLE evidence_history_operator NOLOGIN NOSUPERUSER NOBYPASSRLS');
      await tx.exec('ALTER TABLE link_evidence_history OWNER TO evidence_history_operator');
      await tx.query("SELECT set_config('app.tenant_id', 'MASCLI/PRJ-SECHURA', true)");
      await tx.exec('SET LOCAL ROLE evidence_history_operator');
      expect(await tx.query('SELECT id FROM link_evidence_history')).toHaveLength(3);
      await tx.query("SELECT set_config('app.tenant_id', 'OTHER/TENANT', true)");
      expect(await tx.query('SELECT id FROM link_evidence_history')).toEqual([]);
    });
  });

  it('redacts restricted source identifiers and titles and denies reader evidence edits', async () => {
    const s = await setup();
    await seed(s);
    const created = await s.call('POST', '/system/links', {
      link_type: 'plantea',
      source: { module: 'actores', id: 'A-2' },
      target: { module: 'demandas', id: 'D-1' },
      evidence: { module: 'fuentes', id: 'F-1' },
    });
    await s.call('PUT', '/system/marking', {
      module: 'fuentes',
      id: 'F-1',
      marking: 'restringido',
    });
    await s.t.createAccount(s.admin.cookie, {
      username: 'reader',
      full_name: 'Reader',
      password: 'reader-password-123',
      role: 'consulta',
    });
    await s.t.grant(s.admin.cookie, 'reader');
    const reader = await s.t.login('reader', 'reader-password-123');
    for (const path of [
      '/system/links?module=actores&id=A-2',
      '/system/graph?module=actores&id=A-2',
    ]) {
      const result = await s.call('GET', path, undefined, reader.cookie);
      expect(result.status).toBe(200);
      expect(JSON.stringify(result.body)).not.toContain('F-1');
      expect(JSON.stringify(result.body)).not.toContain('Acta de asamblea');
      expect(JSON.stringify(result.body)).toContain('unavailable');
    }
    expect(
      (
        await s.call(
          'PUT',
          `/system/links/${created.body['id']}/evidence`,
          { evidence: null },
          reader.cookie,
        )
      ).status,
    ).toBe(403);
  });

  it('rejects a source that exists only in another tenant and cross-tenant evidence updates', async () => {
    const s = await setup();
    await seed(s);
    const created = await s.link('plantea', ['actores', 'A-2'], ['demandas', 'D-1']);
    await s.t.createScope(s.admin.cookie, {
      company_id: 'OTRA',
      project_id: 'PRJ-B',
      label: 'Otra',
      username: 'admin',
    });
    const source = await s.t.request('/api/fuentes', {
      method: 'POST',
      headers: {
        cookie: s.admin.cookie,
        'x-mascli-scope': 'OTRA/PRJ-B',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        payload: { ID_Fuente: 'F-OTHER', Archivo_Fuente: 'Other tenant source' },
      }),
    });
    expect(source.status).toBe(200);
    expect(
      (
        await s.call('PUT', `/system/links/${created.body['id']}/evidence`, {
          evidence: { module: 'fuentes', id: 'F-OTHER' },
        })
      ).status,
    ).toBe(404);
    const other = await s.t.request(`/system/links/${created.body['id']}/evidence`, {
      method: 'PUT',
      headers: {
        cookie: s.admin.cookie,
        'x-mascli-scope': 'OTRA/PRJ-B',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ evidence: null }),
    });
    expect(other.status).toBe(404);
  });

  it('rejects invalid links', async () => {
    const s = await setup();
    await seed(s);
    expect(await s.link('participa_en', ['eventos', 'EV-1'], ['actores', 'A-1'])).toEqual({
      status: 422,
      body: { detail: 'El tipo de vínculo no admite esos tipos de objeto' },
    });
    expect((await s.link('inventado', ['actores', 'A-1'], ['eventos', 'EV-1'])).status).toBe(422);
    expect((await s.link('aliado_de', ['actores', 'A-1'], ['actores', 'A-1'])).status).toBe(422);
    expect((await s.link('participa_en', ['actores', 'A-9'], ['eventos', 'EV-1'])).status).toBe(
      404,
    );
    expect((await s.call('POST', '/system/links', { link_type: 'x' })).status).toBe(422);
    expect((await s.call('GET', '/system/links?module=actores&id=NOPE')).status).toBe(404);
  });

  it('stores symmetric links once', async () => {
    const s = await setup();
    await seed(s);
    expect((await s.link('aliado_de', ['actores', 'A-1'], ['actores', 'A-2'])).status).toBe(200);
    expect((await s.link('aliado_de', ['actores', 'A-2'], ['actores', 'A-1'])).status).toBe(409);
  });

  it('infers links from reference fields and actor names', async () => {
    const s = await setup();
    await seed(s);
    const { body } = await s.call('GET', '/system/links?module=eventos&id=EV-1');
    const links = body['links'] as Json[];
    expect(
      links.map((l) => [l['label'], (l['other'] as Json)['id'], (l['edge'] as Json)['via']]),
    ).toEqual([
      ['se sustenta en', 'F-1', 'Fuente_ID'],
      ['tiene como participante a', 'A-1', 'Actor_Principal'],
    ]);
    expect(links.every((l) => (l['edge'] as Json)['inferred'] === true)).toBe(true);
    expect(
      links.every(
        (l) =>
          (l['edge'] as Json)['evidence_status'] === 'undocumented' &&
          (l['edge'] as Json)['evidence'] === null,
      ),
    ).toBe(true);
  });

  it('drops links when a linked record is deleted', async () => {
    const s = await setup();
    await seed(s);
    await s.link('plantea', ['actores', 'A-2'], ['demandas', 'D-1']);
    expect((await s.call('DELETE', '/api/demandas/D-1')).status).toBe(200);
    expect((await s.call('GET', '/system/links?module=actores&id=A-2')).body['links']).toEqual([]);
  });

  it('builds a bounded n-hop graph', async () => {
    const s = await setup();
    await seed(s);
    await s.link('plantea', ['actores', 'A-1'], ['demandas', 'D-1']);
    const one = await s.call('GET', '/system/graph?module=fuentes&id=F-1');
    expect(one.status).toBe(200);
    expect((one.body['nodes'] as Json[]).map((n) => n['id']).sort()).toEqual(['EV-1', 'F-1']);
    const two = await s.call('GET', '/system/graph?module=fuentes&id=F-1&depth=2');
    expect((two.body['nodes'] as Json[]).map((n) => n['id']).sort()).toEqual([
      'A-1',
      'EV-1',
      'F-1',
    ]);
    const three = await s.call('GET', '/system/graph?module=fuentes&id=F-1&depth=9');
    expect((three.body['nodes'] as Json[]).length).toBe(3);
    expect(two.body['edges']).toHaveLength(2);
    expect(two.body['truncated']).toBe(false);
    expect((await s.call('GET', '/system/graph?module=fuentes&id=NOPE')).status).toBe(404);
    expect((await s.call('GET', '/system/graph?module=fuentes&id=F-1&depth=x')).status).toBe(422);
  });

  it('keeps read-only roles from writing and tenants apart', async () => {
    const s = await setup();
    await seed(s);
    await s.t.createAccount(s.admin.cookie, {
      username: 'reader',
      full_name: 'Reader',
      password: 'reader-password-123',
      role: 'consulta',
    });
    await s.t.grant(s.admin.cookie, 'reader');
    const reader = await s.t.login('reader', 'reader-password-123');
    const denied = await s.call(
      'POST',
      '/system/links',
      {
        link_type: 'plantea',
        source: { module: 'actores', id: 'A-1' },
        target: { module: 'demandas', id: 'D-1' },
      },
      reader.cookie,
    );
    expect(denied.status).toBe(403);
    expect(
      (await s.call('GET', '/system/links?module=actores&id=A-1', undefined, reader.cookie)).status,
    ).toBe(200);

    await s.t.createScope(s.admin.cookie, {
      company_id: 'OTRA',
      project_id: 'PRJ-B',
      label: 'Otra',
      username: 'admin',
    });
    const other = await s.t.request('/system/links?module=actores&id=A-1', {
      headers: { cookie: s.admin.cookie, 'x-mascli-scope': 'OTRA/PRJ-B' },
    });
    expect(other.status).toBe(404);
  });
});
