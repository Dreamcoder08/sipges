import { describe, expect, it } from 'vitest';
import {
  alertsByLevel,
  criticalAlerts,
  eventsByDimension,
  eventsByMonth,
  eventsThisWeek,
  recentEvents,
} from './model.ts';

describe('dashboard model', () => {
  it('counts every record of the tenant, with or without Proyecto_ID (S13)', () => {
    // The API already returns only the active project's records (RLS on the tenant).
    const alerts = [
      { _id: 'a', Nivel: 'Rojo' },
      { _id: 'b', Nivel: 'Rojo', Proyecto_ID: '' },
      { _id: 'c', Nivel: 'Rojo', Proyecto_ID: 'PRJ-ALGARROBO' },
    ];
    expect(alertsByLevel(alerts)).toMatchObject({ Rojo: 3 });
    const events = [
      { _id: 'e', Dimension_Principal: 'E', Fecha: '2026-01-02' },
      { _id: 'f', Dimension_Principal: 'E', Fecha: '2026-01-03', Proyecto_ID: 'PRJ-ALGARROBO' },
    ];
    expect(eventsByDimension(events)).toMatchObject({ E: 2 });
    expect(eventsByMonth(events, 1)).toEqual([{ key: '2026-01', label: 'ene 26', value: 2 }]);
    // Inicio and Hoy count the same records.
    expect(criticalAlerts(alerts).map((a) => a.id)).toEqual(['a', 'b', 'c']);
    expect(recentEvents(events).map((e) => e.id)).toEqual(['f', 'e']);
    expect(eventsThisWeek(events, new Date('2026-01-04T12:00:00Z')).total).toBe(2);
  });

  it('counts open alerts of the project by severity, like app.js', () => {
    const counts = alertsByLevel([
      { _id: '1', Nivel_Preliminar: 'Crítica', Proyecto_ID: 'P' },
      { _id: '2', Nivel: 'media', Proyecto_ID: 'P' },
      { _id: '3', Nivel: 'Rojo', Estado: 'Descartado', Proyecto_ID: 'P' },
      { _id: '5' },
    ]);
    expect(counts).toEqual({ Verde: 1, Amarillo: 1, Naranja: 0, Rojo: 1 });
  });

  it('counts events by the first letter of their main dimension', () => {
    expect(
      eventsByDimension([
        { _id: '1', Dimension_Principal: ' e – Ambiental', Proyecto_ID: 'P' },
        { _id: '2', Dimension_Principal: 'X', Proyecto_ID: 'P' },
      ]),
    ).toEqual({ G: 0, A: 0, D: 0, N: 0, E: 1, I: 0 });
  });

  it('counts events per month over the window that ends with the latest event', () => {
    const months = eventsByMonth(
      [
        { _id: '1', Fecha: '2026-01-15', Proyecto_ID: 'P' },
        { _id: '2', Fecha: '2026-01-02', Proyecto_ID: 'P' },
        { _id: '3', Fecha: '2025-11-30', Proyecto_ID: 'P' },
        { _id: '5', Fecha: 'sin fecha', Proyecto_ID: 'P' },
      ],
      3,
    );
    expect(months).toEqual([
      { key: '2025-11', label: 'nov 25', value: 1 },
      { key: '2025-12', label: 'dic 25', value: 0 },
      { key: '2026-01', label: 'ene 26', value: 2 },
    ]);
    expect(eventsByMonth([{ _id: '1', Proyecto_ID: 'P' }])).toEqual([]);
  });

  it('lists the open alerts that need action first, highest band and newest first', () => {
    const items = criticalAlerts([
      {
        _id: 'a',
        Causa: 'Bloqueo de vía',
        Nivel_Preliminar: 'Naranja',
        Fecha: '2026-10-01',
        Proyecto_ID: 'P',
      },
      {
        _id: 'b',
        Causa: 'Paro',
        Nivel_Preliminar: 'Rojo',
        Fecha: '2026-09-01',
        Proyecto_ID: 'P',
      },
      {
        _id: 'c',
        Causa: 'Reclamo',
        Nivel_Preliminar: 'Naranja',
        Fecha: '2026-10-09',
        Proyecto_ID: 'P',
      },
      { _id: 'd', Causa: 'Rumor', Nivel_Preliminar: 'Verde', Proyecto_ID: 'P' },
      {
        _id: 'e',
        Causa: 'Cerrada',
        Nivel_Preliminar: 'Rojo',
        Estado: 'Cerrada',
        Proyecto_ID: 'P',
      },
    ]);
    expect(items.map((i) => [i.id, i.level])).toEqual([
      ['b', 'Rojo'],
      ['c', 'Naranja'],
      ['a', 'Naranja'],
    ]);
  });

  it('lists the newest events of the project with their dimension', () => {
    const items = recentEvents(
      [
        { _id: '1', Descripcion_Hecho: 'Asamblea', Fecha: '2026-08-01', Proyecto_ID: 'P' },
        {
          _id: '2',
          Descripcion_Hecho: 'Derrame',
          Dimension_Principal: 'E',
          Fecha: '2026-10-02',
          Proyecto_ID: 'P',
        },
        { _id: '3', Proyecto_ID: 'P' },
      ],
      5,
    );
    expect(items.map((i) => [i.id, i.dimension])).toEqual([
      ['2', 'E'],
      ['1', null],
      ['3', null],
    ]);
    expect(items[2]?.title).toBe('Evento sin descripción');
  });
});

describe('eventsThisWeek', () => {
  const now = new Date('2026-11-01T15:00:00Z');
  const events = [
    { _id: 'a', Descripcion_Hecho: 'Hoy', Fecha: '2026-11-01', Proyecto_ID: 'P' },
    { _id: 'b', Descripcion_Hecho: 'Hace seis días', Fecha: '2026-10-26', Proyecto_ID: 'P' },
    { _id: 'c', Descripcion_Hecho: 'Hace un mes', Fecha: '2026-10-01', Proyecto_ID: 'P' },
    { _id: 'd', Descripcion_Hecho: 'Sin fecha', Proyecto_ID: 'P' },
  ];

  it('counts the last seven days of the active project, newest first', () => {
    const week = eventsThisWeek(events, now, 1);
    expect(week.total).toBe(2);
    expect(week.items.map((item) => item.id)).toEqual(['a']);
  });

  // Seven Lima calendar days, today included: 7 to 13 November, whatever the UTC hour.
  const edges = [
    { _id: 'before', Fecha: '2026-11-06' },
    { _id: 'first', Fecha: '2026-11-07' },
    { _id: 'last', Fecha: '2026-11-13' },
    { _id: 'after', Fecha: '2026-11-14' },
  ];
  it.each(['2026-11-13T23:30:00-05:00', '2026-11-13T08:00:00-05:00'])(
    'keeps the window on the Lima calendar at %s',
    (at) => {
      const week = eventsThisWeek(edges, new Date(at), Number.POSITIVE_INFINITY);
      expect(week.items.map((item) => item.id)).toEqual(['last', 'first']);
    },
  );
});
