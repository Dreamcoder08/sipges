import { describe, expect, it } from 'vitest';
import { PSEUDONYM, leaks, setupPrivacy } from './support.ts';

const DISABLED = 'El envío a IA externa está desactivado para este proyecto';

const READ_CALLS = [
  ['search_records', { query: 'asamblea' }],
  ['get_record', { module: 'eventos', id: 'EV-1' }],
  ['get_links', { module: 'actores', id: 'A-1' }],
  ['get_timeline', { from: '2026-10', to: '2026-10' }],
  ['get_briefing', { module: 'actores', id: 'A-1' }],
] as const;

describe('project switch «Envío a IA externa»', () => {
  it('is off by default and changed only by administrators, with an audit entry', async () => {
    const t = await setupPrivacy();
    expect((await t.call('GET', '/system/v4/settings')).body.external_ai).toEqual({
      enabled: false,
    });
    await t.createAccount(t.admin.cookie, {
      username: 'ana',
      full_name: 'Ana',
      password: 'ana-password-123',
      role: 'analista',
    });
    await t.grant(t.admin.cookie, 'ana');
    const ana = await t.login('ana', 'ana-password-123');
    const denied = await t.call(
      'PUT',
      '/system/v4/settings',
      { external_ai: { enabled: true } },
      { cookie: ana.cookie },
    );
    expect(denied.status).toBe(403);
    expect((await t.call('GET', '/system/v4/settings')).body.external_ai.enabled).toBe(false);

    const saved = await t.setSwitch(true);
    expect(saved.status).toBe(200);
    expect(saved.body.external_ai).toEqual({ enabled: true });
    const changed = (await t.audit()).find((row) => row.action === 'CONFIG_UPDATE');
    expect(changed?.detail).toContain('externalAi');
  });
});

describe('MCP data tools with the switch off', () => {
  it('refuse every data tool with a clear error and send nothing', async () => {
    const t = await setupPrivacy();
    await t.seed();
    const { token } = await t.key('Agente');
    for (const [name, args] of READ_CALLS) {
      const result = await t.tool(token, name, args);
      expect(result, name).toEqual({ content: [{ type: 'text', text: DISABLED }], isError: true });
    }
    expect(await t.egressRows()).toEqual([]);
  });

  it('keeps the static catalogue and the write tools working', async () => {
    const t = await setupPrivacy();
    const reader = await t.key('Lector');
    const catalogue = await t.tool(reader.token, 'list_object_types', {});
    expect(catalogue.isError).toBe(false);
    const writer = await t.key('Integración', undefined, 'write');
    const created = await t.tool(writer.token, 'create_record', {
      module: 'demandas',
      payload: { ID_Demanda: 'D-77', Descripcion: 'Agua potable sintética' },
    });
    expect(created.structuredContent).toEqual({ module: 'demandas', id: 'D-77' });
    const linked = await t.tool(writer.token, 'link_records', {
      link_type: 'relacionado_con',
      source: { module: 'demandas', id: 'D-77' },
      target: { module: 'demandas', id: 'D-77' },
    });
    expect(linked.isError).toBe(true);
    expect(linked.content[0].text).toBe('Vínculo rechazado: self_link');
  });
});

describe('MCP data tools with the switch on', () => {
  it('release only allowed fields, pseudonymised, with no names, contacts or sensitive data', async () => {
    const t = await setupPrivacy();
    await t.seed();
    await t.setSwitch(true);
    const { token } = await t.key('Agente');
    const seen: string[] = [];
    for (const [name, args] of READ_CALLS) {
      const result = await t.tool(token, name, args);
      expect(result.isError, `${name}: ${JSON.stringify(result)}`).toBe(false);
      const text = JSON.stringify(result);
      expect(leaks(text), name).toEqual([]);
      seen.push(text);
    }
    const record = (await t.tool(token, 'get_record', { module: 'eventos', id: 'EV-1' }))
      .structuredContent;
    expect(record.payload.Fecha).toBe('2026-10-01');
    expect(record.payload.Territorio).toBe('Sechura');
    expect(record.payload.Actor_Principal).toMatch(/^Actor-[0-9A-F]{6}$/);
    expect(record.payload.Descripcion_Hecho).toMatch(/Persona-[0-9A-F]{6}/);
    expect(record.payload.Descripcion_Hecho).toContain('[correo]');
    expect(record.payload.Descripcion_Hecho).toContain('[teléfono]');
    expect(record.payload.Descripcion_Hecho).toContain('[DNI]');
    // Not on the allowlist: dropped, whatever it holds.
    expect(Object.keys(record.payload)).not.toContain('Observaciones');
    const actor = (await t.tool(token, 'get_record', { module: 'actores', id: 'A-1' }))
      .structuredContent;
    for (const dropped of ['Posicion_Proyecto', 'Interes', 'Telefono'])
      expect(Object.keys(actor.payload)).not.toContain(dropped);
    expect(actor.payload['Nombre_Actor/Organizacion']).toMatch(/^Actor-[0-9A-F]{6}$/);
    const buzon = (await t.tool(token, 'get_record', { module: 'buzon', id: 'BZ-1' }))
      .structuredContent;
    expect(Object.keys(buzon.payload).sort()).toEqual(['Asunto', 'Fecha', 'ID_Caso', 'Tipo']);
    expect(seen.join('')).toMatch(PSEUDONYM);
  });

  it('gives the same pseudonym on every call and a different one in another project', async () => {
    const t = await setupPrivacy();
    await t.createScope(t.admin.cookie, {
      company_id: 'ACME',
      project_id: 'NORTE',
      label: 'Norte sintético',
      username: 'admin',
    });
    await t.seed();
    await t.seed('ACME/NORTE');
    await t.setSwitch(true);
    await t.setSwitch(true, 'ACME/NORTE');
    const sechura = await t.key('Agente');
    const norte = await t.key('Agente', 'ACME/NORTE');
    const title = async (token: string) =>
      (await t.tool(token, 'get_record', { module: 'actores', id: 'A-1' })).structuredContent
        .payload['Nombre_Actor/Organizacion'] as string;
    const first = await title(sechura.token);
    expect(await title(sechura.token)).toBe(first);
    const other = await title(norte.token);
    expect(other).toMatch(/^Actor-[0-9A-F]{6}$/);
    expect(other).not.toBe(first);
    // The same actor named in a title elsewhere resolves to the same pseudonym.
    const search = await t.tool(sechura.token, 'search_records', { query: 'comunidad' });
    expect(JSON.stringify(search)).toContain(first);
  });

  it('logs each release in Auditoría without any data value', async () => {
    const t = await setupPrivacy();
    await t.seed();
    await t.setSwitch(true);
    const agent = await t.key('Agente');
    await t.tool(agent.token, 'get_record', { module: 'eventos', id: 'EV-1' });
    await t.tool(agent.token, 'search_records', { query: 'asamblea' });
    const rows = await t.egressRows();
    expect(rows).toHaveLength(2);
    const [search, record] = rows as [Record<string, string>, Record<string, string>];
    expect(record).toMatchObject({ module: 'IA externa', action: 'EGRESS' });
    expect(record.detail).toContain('mcp');
    expect(record.detail).toContain('get_record');
    expect(record.detail).toContain(`api:Agente (clave ${agent.id})`);
    expect(record.detail).toContain('eventos/EV-1');
    expect(record.detail).toMatch(/campos enviados: \d+/);
    expect(record.detail).toMatch(/descartados: \d+/);
    expect(search?.detail).toContain('search_records');
    for (const row of rows) {
      expect(leaks(JSON.stringify(row))).toEqual([]);
      expect(row.detail).not.toContain('Asamblea convocada');
      expect(row.detail).not.toContain('2026-10-01');
    }
    expect(JSON.stringify(rows)).not.toMatch(PSEUDONYM);
  });

  it('counts the fields it drops', async () => {
    const t = await setupPrivacy();
    await t.seed();
    await t.setSwitch(true);
    const agent = await t.key('Agente');
    await t.tool(agent.token, 'get_record', { module: 'actores', id: 'A-1' });
    const [row] = await t.egressRows();
    // Posicion_Proyecto, Interes and Telefono never leave.
    expect(row?.detail).toMatch(/descartados: 3/);
    expect(row?.detail).toContain('Posicion_Proyecto');
  });
});

describe('isolation and writes stay as they were (S7)', () => {
  it('a key of one project cannot read a record of another', async () => {
    const t = await setupPrivacy();
    await t.createScope(t.admin.cookie, {
      company_id: 'ACME',
      project_id: 'NORTE',
      label: 'Norte sintético',
      username: 'admin',
    });
    await t.call(
      'POST',
      '/api/eventos',
      { payload: { ID_Evento: 'EV-NORTE', Descripcion_Hecho: 'Solo en el proyecto Norte' } },
      { scope: 'ACME/NORTE' },
    );
    await t.setSwitch(true);
    await t.setSwitch(true, 'ACME/NORTE');
    const sechura = await t.key('Agente');
    const read = await t.tool(sechura.token, 'get_record', { module: 'eventos', id: 'EV-NORTE' });
    expect(read).toMatchObject({ isError: true, content: [{ text: 'Registro no encontrado' }] });
    const search = await t.tool(sechura.token, 'search_records', { query: 'Norte' });
    expect(search.structuredContent.hits).toEqual([]);
  });

  it('the switch of one project does not open another', async () => {
    const t = await setupPrivacy();
    await t.createScope(t.admin.cookie, {
      company_id: 'ACME',
      project_id: 'NORTE',
      label: 'Norte sintético',
      username: 'admin',
    });
    await t.setSwitch(true);
    const norte = await t.key('Agente', 'ACME/NORTE');
    const result = await t.tool(norte.token, 'search_records', { query: 'x' });
    expect(result).toEqual({ content: [{ type: 'text', text: DISABLED }], isError: true });
  });

  it('writes still need a write key and keep the audit of the key', async () => {
    const t = await setupPrivacy();
    await t.setSwitch(true);
    const writer = await t.key('Integración n8n', undefined, 'write');
    const created = await t.tool(writer.token, 'create_record', {
      module: 'demandas',
      payload: { ID_Demanda: 'D-9', Descripcion: 'Agua potable sintética' },
    });
    expect(created.structuredContent).toEqual({ module: 'demandas', id: 'D-9' });
    const history = await t.call('GET', '/api/demandas/D-9/history');
    expect((history.body as unknown as Record<string, string>[])[0]).toMatchObject({
      actor: 'api:Integración n8n',
    });
  });
});
