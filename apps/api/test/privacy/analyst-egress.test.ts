import { describe, expect, it } from 'vitest';
import type { Narrator } from '../../src/contexts/analyst/application/index.ts';
import { PSEUDONYM, leaks, setupPrivacy } from './support.ts';

const recording = () => {
  const seen: string[] = [];
  const narrator: Narrator = {
    name: 'prueba',
    narrate: async (briefing) => {
      seen.push(briefing);
      return 'La asamblea se registró [1].';
    },
  };
  return { narrator, seen };
};

describe('analyst narrator', () => {
  it('is not called while the switch is off and the extractive briefing stays', async () => {
    const { narrator, seen } = recording();
    const t = await setupPrivacy({ narrator });
    await t.seed();
    const { status, body } = await t.call('GET', '/system/briefing?module=eventos&id=EV-1');
    expect(status).toBe(200);
    expect(seen).toEqual([]);
    expect(body).toMatchObject({
      engine: 'extractivo',
      narrative: null,
      notice: 'El resumen asistido no estuvo disponible; se muestra el informe extractivo.',
    });
    expect(await t.egressRows()).toEqual([]);
  });

  it('sends a pseudonymised prompt with no names, contacts or sensitive fields', async () => {
    const { narrator, seen } = recording();
    const t = await setupPrivacy({ narrator });
    await t.seed();
    await t.setSwitch(true);
    const { body } = await t.call('GET', '/system/briefing?module=actores&id=A-1');
    expect(seen).toHaveLength(1);
    expect(leaks(seen[0] ?? '')).toEqual([]);
    expect(seen[0]).toMatch(PSEUDONYM);
    expect(seen[0]).not.toContain('Posicion');
    expect(seen[0]).not.toContain('Telefono');
    expect(body).toMatchObject({ engine: 'asistido' });
    // The extractive briefing for the signed-in team keeps the real records.
    expect(JSON.stringify(body.sections)).toContain('Comunidad Campesina Los Algarrobos');
    const [row] = await t.egressRows();
    expect(row).toMatchObject({ action: 'EGRESS' });
    expect(row?.detail).toContain('analyst');
    expect(row?.detail).toContain('briefing');
    expect(row?.detail).toContain('actores/A-1');
    expect(row?.detail).toContain('admin');
    expect(leaks(JSON.stringify(row))).toEqual([]);
  });

  it('gives the model the same pseudonym on every briefing', async () => {
    const { narrator, seen } = recording();
    const t = await setupPrivacy({ narrator });
    await t.seed();
    await t.setSwitch(true);
    await t.call('GET', '/system/briefing?module=actores&id=A-1');
    await t.call('GET', '/system/briefing?module=eventos&id=EV-1');
    const first = new Set(seen[0]?.match(PSEUDONYM));
    const second = seen[1]?.match(PSEUDONYM) ?? [];
    expect(second.some((p) => first.has(p))).toBe(true);
  });

  it('shows the pseudonymised MCP briefing built from allowed fields only', async () => {
    const t = await setupPrivacy();
    await t.seed();
    await t.setSwitch(true);
    const { token } = await t.key('Agente');
    const result = await t.tool(token, 'get_briefing', { module: 'actores', id: 'A-1' });
    const text = JSON.stringify(result);
    expect(leaks(text)).toEqual([]);
    expect(text).not.toContain('Posicion');
    expect(text).toMatch(PSEUDONYM);
  });
});
