import { describe, expect, it } from 'vitest';
import { createTestApp } from '../support/test-app.ts';

// Response bodies are inspected loosely; their shapes are covered by the contracts.
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
  const key = async (name: string, access = 'read', clearance = 'limited') => {
    const res = await call('POST', '/system/integrations/api-keys', { name, access, clearance });
    expect(res.status).toBe(200);
    return res.body as { id: number; token: string };
  };
  let nextId = 1;
  const rpc = async (
    token: string,
    method: string,
    params?: unknown,
    headers: Record<string, string> = {},
  ) => {
    const res = await t.request('/mcp', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        origin: '',
        ...headers,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, ...(params ? { params } : {}) }),
    });
    return { status: res.status, body: (await res.json()) as Json };
  };
  const tool = async (token: string, name: string, args: unknown) =>
    (await rpc(token, 'tools/call', { name, arguments: args })).body.result as Json;

  await call('POST', '/api/actores', {
    payload: { ID_Actor: 'A-1', 'Nombre_Actor/Organizacion': 'Comunidad Norte' },
  });
  await call('POST', '/api/eventos', {
    payload: { ID_Evento: 'EV-1', Fecha: '2026-10-01', Descripcion: 'Asamblea comunal sintética' },
  });
  await call('POST', '/api/actores', {
    payload: { ID_Actor: 'A-2', 'Nombre_Actor/Organizacion': 'Fuente reservada' },
  });
  await call('PUT', '/system/marking', { module: 'actores', id: 'A-2', marking: 'restringido' });
  return { ...t, admin, call, key, rpc, tool };
};

describe('API keys', () => {
  it('shows the token once, lists only metadata and stays with administrators', async () => {
    const t = await setup();
    const created = await t.key('Agente de lectura');
    expect(created.token).toMatch(/^mscli_[a-f0-9]{12}_[A-Za-z0-9_-]{43}$/);
    const list = await t.call('GET', '/system/integrations/api-keys');
    expect(list.body).toEqual([
      expect.objectContaining({
        name: 'Agente de lectura',
        access: 'read',
        clearance: 'limited',
        revoked_at: null,
      }),
    ]);
    expect(JSON.stringify(list.body)).not.toContain(created.token.slice(20));
    expect(
      (await t.call('POST', '/system/integrations/api-keys', { name: 'Agente de lectura' })).status,
    ).toBe(409);

    await t.createAccount(t.admin.cookie, {
      username: 'ana',
      full_name: 'Ana',
      password: 'ana-password-123',
      role: 'analista',
    });
    await t.grant(t.admin.cookie, 'ana');
    const ana = await t.login('ana', 'ana-password-123');
    expect(
      (await t.call('GET', '/system/integrations/api-keys', undefined, ana.cookie)).status,
    ).toBe(403);
  });

  it('stops working once revoked, and never authenticates the browser API', async () => {
    const t = await setup();
    const { id, token } = await t.key('Temporal');
    expect((await t.rpc(token, 'ping')).status).toBe(200);
    const browserApi = await t.request('/api/actores', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(browserApi.status).toBe(401);
    expect((await t.call('DELETE', `/system/integrations/api-keys/${id}`)).status).toBe(200);
    const after = await t.rpc(token, 'ping');
    expect(after.status).toBe(401);
    const audit = (await t.call('GET', '/system/audit?limit=10')).body as unknown as Json[];
    expect(audit.filter((a) => a.module === 'Integraciones').map((a) => a.action)).toEqual([
      'DELETE',
      'CREATE',
    ]);
  });
});

describe('MCP server', () => {
  it('rejects requests without a valid key or from a foreign browser origin', async () => {
    const t = await setup();
    const res = await t.request('/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: '' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain('Bearer');
    const { token } = await t.key('Agente');
    expect((await t.rpc(token, 'ping', undefined, { origin: 'https://evil.example' })).status).toBe(
      403,
    );
    expect(
      (await t.request('/mcp', { headers: { authorization: `Bearer ${token}` } })).status,
    ).toBe(405);
  });

  it('negotiates the protocol and lists read tools for read keys', async () => {
    const t = await setup();
    const { token } = await t.key('Agente');
    const init = await t.rpc(token, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '1' },
    });
    expect(init.body.result).toMatchObject({
      protocolVersion: '2025-06-18',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'sipges' },
    });
    expect(
      (await t.rpc(token, 'initialize', { protocolVersion: '1999-01-01' })).body.result
        .protocolVersion,
    ).toBe('2025-11-25');
    const notification = await t.request('/mcp', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', origin: '' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });
    expect(notification.status).toBe(202);

    const tools = (await t.rpc(token, 'tools/list')).body.result.tools as Json[];
    expect(tools.map((x) => x.name)).toEqual([
      'list_object_types',
      'search_records',
      'get_record',
      'get_links',
      'get_timeline',
      'get_briefing',
    ]);
    expect(tools[1]).toMatchObject({
      inputSchema: { type: 'object', required: ['query'] },
      annotations: { readOnlyHint: true },
    });
    expect((await t.rpc(token, 'resources/list')).body.error.code).toBe(-32601);
  });

  it('answers searches, records, links, timelines and briefings within the key clearance', async () => {
    const t = await setup();
    const { token } = await t.key('Agente');
    const search = await t.tool(token, 'search_records', { query: 'comunidad' });
    expect(search.isError).toBe(false);
    expect(search.structuredContent.hits[0]).toMatchObject({
      module: 'actores',
      id: 'A-1',
      title: 'Comunidad Norte',
    });

    const record = await t.tool(token, 'get_record', { module: 'eventos', id: 'EV-1' });
    expect(record.structuredContent).toMatchObject({
      id: 'EV-1',
      payload: { Fecha: '2026-10-01' },
    });
    expect((await t.tool(token, 'get_links', { module: 'actores', id: 'A-1' })).isError).toBe(
      false,
    );
    const timeline = await t.tool(token, 'get_timeline', { from: '2026-10', to: '2026-10' });
    expect(timeline.structuredContent.entries.map((e: Json) => e.id)).toEqual(['EV-1']);
    const briefing = await t.tool(token, 'get_briefing', { module: 'actores', id: 'A-1' });
    expect(briefing.structuredContent).toMatchObject({
      engine: 'extractivo',
      subject: { id: 'A-1' },
    });

    // A limited key never sees restricted records; a full-clearance key does.
    expect((await t.tool(token, 'get_record', { module: 'actores', id: 'A-2' })).isError).toBe(
      true,
    );
    expect(
      (await t.tool(token, 'search_records', { query: 'reservada' })).structuredContent.hits,
    ).toEqual([]);
    const full = await t.key('Analista total', 'read', 'full');
    expect(
      (await t.tool(full.token, 'get_record', { module: 'actores', id: 'A-2' })).structuredContent,
    ).toMatchObject({
      marking: 'restringido',
    });

    const invalid = await t.tool(token, 'get_record', { module: 'actores' });
    expect(invalid).toMatchObject({ isError: true });
    expect(invalid.content[0].text).toContain('id');
  });

  it('writes only with write keys, inside the key project, audited as the key', async () => {
    const t = await setup();
    const reader = await t.key('Lector');
    expect(
      (await t.rpc(reader.token, 'tools/call', { name: 'create_record', arguments: {} })).body.error
        .code,
    ).toBe(-32602);

    const writer = await t.key('Integración n8n', 'write');
    const created = await t.tool(writer.token, 'create_record', {
      module: 'demandas',
      payload: { ID_Demanda: 'D-77', Demanda: 'Agua potable sintética' },
    });
    expect(created.structuredContent).toEqual({ module: 'demandas', id: 'D-77' });
    const history = await t.call('GET', '/api/demandas/D-77/history');
    expect((history.body as unknown as Json[])[0]).toMatchObject({ actor: 'api:Integración n8n' });

    const foreign = await t.tool(writer.token, 'create_record', {
      module: 'demandas',
      payload: { Proyecto_ID: 'OTRO', Demanda: 'x' },
    });
    expect(foreign).toMatchObject({
      isError: true,
      content: [{ text: 'No se permite escribir en otro proyecto' }],
    });

    const linked = await t.tool(writer.token, 'link_records', {
      link_type: 'participa_en',
      source: { module: 'actores', id: 'A-1' },
      target: { module: 'eventos', id: 'EV-1' },
    });
    expect(linked.isError).toBe(false);
    const links = await t.call('GET', '/system/links?module=actores&id=A-1');
    expect(links.body.links.find((l: Json) => !l.edge.inferred).edge.created_by).toBe(
      'api:Integración n8n',
    );
  });
});
