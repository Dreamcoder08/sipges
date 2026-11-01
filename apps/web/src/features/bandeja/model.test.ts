import { describe, expect, it } from 'vitest';
import { ageLabel, fourEyesFor, groupItems, orderItems, qualityItems } from './model.ts';

describe('fourEyesFor', () => {
  it('needs two people only for a high-priority alert', () => {
    expect(fourEyesFor({ level: 'Media', first_validator: null }, 'demo', true)).toMatchObject({
      required: false,
      canDecide: true,
    });
    expect(fourEyesFor({ level: 'Alta', first_validator: null }, 'demo', true)).toMatchObject({
      required: true,
      canDecide: true,
    });
  });

  it('refuses the person who validated first, allows anyone else', () => {
    const alert = { level: 'Alta', first_validator: 'ana' };
    expect(fourEyesFor(alert, 'ana', true).canDecide).toBe(false);
    expect(fourEyesFor(alert, 'luis', true).canDecide).toBe(true);
  });

  it('never lets a read-only role decide', () => {
    expect(fourEyesFor({ level: 'Baja', first_validator: null }, 'demo', false).canDecide).toBe(
      false,
    );
  });
});

describe('ageLabel', () => {
  const now = Date.parse('2026-11-01T12:00:00Z');
  it.each([
    ['2026-11-01T11:50:00Z', 'hace minutos'],
    ['2026-11-01T07:00:00Z', 'hace 5 h'],
    ['2026-10-29T12:00:00Z', 'hace 3 d'],
    [null, null],
    ['no es fecha', null],
  ])('%s → %s', (since, label) => expect(ageLabel(since, now)).toBe(label));
});

describe('qualityItems', () => {
  it('groups the observations of one record into one item', () => {
    const items = qualityItems([
      {
        module: 'actores',
        id: 'AC-1',
        title: 'Actor',
        field: 'Territorio',
        reason: 'Sin territorio',
      },
      { module: 'actores', id: 'AC-1', title: 'Actor', field: 'Fuente_ID', reason: 'Sin fuente' },
      { module: 'eventos', id: 'EV-1', title: 'Evento', field: 'Fuente_ID', reason: 'Sin fuente' },
    ]);
    expect(items.map((item) => item.title)).toEqual([
      'Actor: 2 observaciones',
      'Evento: 1 observación',
    ]);
    expect(items[0]?.owner.href).toBe('/objeto/actores/AC-1');
  });
});

describe('orderItems', () => {
  it('puts the most urgent first, then the oldest waiting, then undated', () => {
    const item = (key: string, urgency: 'urgent' | 'routine', since: string | null) =>
      ({ key, urgency, since }) as never;
    const ordered = orderItems([
      item('b', 'routine', null),
      item('c', 'urgent', '2026-10-02'),
      item('a', 'urgent', '2026-10-01'),
    ]);
    expect(ordered.map((entry) => entry.key)).toEqual(['a', 'c', 'b']);
    expect(groupItems(ordered).map((group) => group.value)).toEqual(['urgent', 'routine']);
  });
});
