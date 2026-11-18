import { describe, expect, it } from 'vitest';
import { setupPrivacy } from './support.ts';

const DISABLED = 'El envío a IA externa está desactivado para este proyecto';
const BAD_DATES = 'Fechas no válidas: use AAAA, AAAA-MM o AAAA-MM-DD';
const refused = (field: string) =>
  `No se puede agrupar por «${field}»: solo campos de lista cerrada, códigos, fechas o números`;

type Fixture = Awaited<ReturnType<typeof setupPrivacy>>;

/**
 * The seeded project (EV-1, Sechura, 2026-10-01) plus three open events and a restricted one:
 * EV-2 Sechura 2026-11-03, EV-3 Paita 2025-05-10, EV-4 without territory or date, and EV-9
 * (Sechura, 2026-10-05) marked «restringido».
 */
const withEvents = async (t: Fixture) => {
  await t.seed();
  const post = (payload: Record<string, string>) => t.call('POST', '/api/eventos', { payload });
  await post({ ID_Evento: 'EV-2', Fecha: '2026-11-03', Territorio: 'Sechura' });
  await post({ ID_Evento: 'EV-3', Fecha: '2025-05-10', Territorio: 'Paita' });
  await post({ ID_Evento: 'EV-4', Descripcion_Hecho: 'Reunión sin fecha' });
  await post({ ID_Evento: 'EV-9', Fecha: '2026-10-05', Territorio: 'Sechura' });
  await t.call('PUT', '/system/marking', { module: 'eventos', id: 'EV-9', marking: 'restringido' });
};

/** A full-clearance key: it sees EV-9 inside SIPGES, so only the guard keeps it out. */
const agent = async (t: Fixture) => (await t.key('Reportes', undefined, 'read', 'full')).token;

describe('count_records', () => {
  it('is refused while «Envío a IA externa» is off and logs nothing', async () => {
    const t = await setupPrivacy();
    await withEvents(t);
    const result = await t.tool(await agent(t), 'count_records', { module: 'eventos' });
    expect(result).toEqual({ content: [{ type: 'text', text: DISABLED }], isError: true });
    expect(await t.egressRows()).toEqual([]);
  });

  it('answers the total of the module without group_by', async () => {
    const t = await setupPrivacy();
    await withEvents(t);
    await t.setSwitch(true);
    const result = await t.tool(await agent(t), 'count_records', { module: 'eventos' });
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toEqual({
      module: 'eventos',
      group_by: null,
      from: null,
      to: null,
      total: 4,
      truncated: false,
      groups: [],
    });
  });

  it('groups by a closed-list field, largest first, value as text, null last', async () => {
    const t = await setupPrivacy();
    await withEvents(t);
    await t.setSwitch(true);
    const result = await t.tool(await agent(t), 'count_records', {
      module: 'eventos',
      group_by: 'Territorio',
    });
    expect(result.structuredContent).toEqual({
      module: 'eventos',
      group_by: 'Territorio',
      from: null,
      to: null,
      total: 4,
      truncated: false,
      groups: [
        { value: 'Sechura', count: 2 },
        { value: 'Paita', count: 1 },
        { value: null, count: 1 },
      ],
    });
  });

  it('keeps a number as a number and sorts it before the same text on a tie', async () => {
    const t = await setupPrivacy();
    await t.setSwitch(true);
    const post = (payload: Record<string, unknown>) => t.call('POST', '/api/eventos', { payload });
    await post({ ID_Evento: 'EV-31', Territorio: '12' });
    await post({ ID_Evento: 'EV-32', Territorio: 12 });
    await post({ ID_Evento: 'EV-33' });
    const result = await t.tool(await agent(t), 'count_records', {
      module: 'eventos',
      group_by: 'Territorio',
    });
    expect(result.structuredContent).toMatchObject({
      total: 3,
      groups: [
        { value: 12, count: 1 },
        { value: '12', count: 1 },
        { value: null, count: 1 },
      ],
    });
  });

  it('bounds the count by dates on the date field and leaves undated records out', async () => {
    const t = await setupPrivacy();
    await withEvents(t);
    await t.setSwitch(true);
    const token = await agent(t);
    const year = await t.tool(token, 'count_records', {
      module: 'eventos',
      group_by: 'Territorio',
      from: '2026',
      to: '2026',
    });
    expect(year.structuredContent).toMatchObject({
      from: '2026-01-01',
      to: '2026-12-31',
      total: 2,
      groups: [{ value: 'Sechura', count: 2 }],
    });
    const month = await t.tool(token, 'count_records', { module: 'eventos', from: '2026-10' });
    expect(month.structuredContent).toMatchObject({
      from: '2026-10-01',
      to: null,
      total: 2,
    });
    const day = await t.tool(token, 'count_records', { module: 'eventos', to: '2025-05-10' });
    expect(day.structuredContent).toMatchObject({ from: null, to: '2025-05-10', total: 1 });
    // Blank sides are empty: no bound, and undated records still count.
    const blank = await t.tool(token, 'count_records', { module: 'eventos', from: '  ', to: ' ' });
    expect(blank.structuredContent).toMatchObject({ from: null, to: null });
  });

  it('refuses dates on a type without date field', async () => {
    const t = await setupPrivacy();
    await withEvents(t);
    await t.setSwitch(true);
    const result = await t.tool(await agent(t), 'count_records', {
      module: 'actores',
      from: '2026',
    });
    expect(result).toEqual({
      content: [{ type: 'text', text: 'El tipo de objeto actores no tiene campo de fecha' }],
      isError: true,
    });
  });

  it('refuses invalid dates and an unknown module', async () => {
    const t = await setupPrivacy();
    await withEvents(t);
    await t.setSwitch(true);
    const token = await agent(t);
    for (const dates of [{ from: '2026-13' }, { to: 'ayer' }, { from: '26-10-01' }]) {
      const result = await t.tool(token, 'count_records', { module: 'eventos', ...dates });
      expect(result, JSON.stringify(dates)).toEqual({
        content: [{ type: 'text', text: BAD_DATES }],
        isError: true,
      });
    }
    const unknown = await t.tool(token, 'count_records', { module: 'planetas' });
    expect(unknown).toEqual({
      content: [{ type: 'text', text: 'Módulo no válido' }],
      isError: true,
    });
  });

  it('checks the module, then the dates, then the date field, then group_by', async () => {
    const t = await setupPrivacy();
    await t.setSwitch(true);
    const token = await agent(t);
    const error = async (args: Record<string, string>) =>
      (await t.tool(token, 'count_records', args)).content[0].text as string;
    expect(await error({ module: 'planetas', from: 'ayer', group_by: 'Nada' })).toBe(
      'Módulo no válido',
    );
    expect(await error({ module: 'actores', from: 'ayer', group_by: 'Nada' })).toBe(BAD_DATES);
    expect(await error({ module: 'actores', from: '2026', group_by: 'Nada' })).toBe(
      'El tipo de objeto actores no tiene campo de fecha',
    );
    expect(await error({ module: 'eventos', from: '2026', group_by: 'Nada' })).toBe(
      refused('Nada'),
    );
  });

  it('refuses a name, a free-text or a non-allowlisted field as group_by', async () => {
    const t = await setupPrivacy();
    await withEvents(t);
    await t.setSwitch(true);
    const token = await agent(t);
    for (const field of ['Actor_Principal', 'Descripcion_Hecho', 'Observaciones', 'Nada']) {
      const result = await t.tool(token, 'count_records', { module: 'eventos', group_by: field });
      expect(result, field).toEqual({
        content: [{ type: 'text', text: refused(field) }],
        isError: true,
      });
    }
    // A refused field reads nothing, so nothing is logged as sent.
    expect(await t.egressRows()).toEqual([]);
  });

  it('does not count restricted records, grouped or not', async () => {
    const t = await setupPrivacy();
    await withEvents(t);
    await t.setSwitch(true);
    const token = await agent(t);
    // Without the restricted EV-9, October 2026 holds only EV-1.
    const october = await t.tool(token, 'count_records', {
      module: 'eventos',
      group_by: 'Territorio',
      from: '2026-10',
      to: '2026-10',
    });
    expect(october.structuredContent).toMatchObject({
      total: 1,
      groups: [{ value: 'Sechura', count: 1 }],
    });
    expect(JSON.stringify(october)).not.toContain('EV-9');
  });

  it('writes one access-log row for the call', async () => {
    const t = await setupPrivacy();
    await withEvents(t);
    await t.setSwitch(true);
    const token = await agent(t);
    await t.tool(token, 'count_records', { module: 'eventos', group_by: 'Territorio' });
    const rows = await t.egressRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ module: 'IA externa', action: 'EGRESS' });
    expect(rows[0]?.detail).toContain('count_records');
    expect(rows[0]?.detail).toContain('eventos/EV-1');
  });
});
