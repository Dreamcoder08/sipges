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
  it('counts open alerts of the project by severity, like app.js', () => {
    const counts = alertsByLevel(
      [
        { _id: '1', Nivel_Preliminar: 'Crítica', Proyecto_ID: 'P' },
        { _id: '2', Nivel: 'media', Proyecto_ID: 'P' },
        { _id: '3', Nivel: 'Rojo', Estado: 'Descartado', Proyecto_ID: 'P' },
        { _id: '4', Nivel: 'Rojo', Proyecto_ID: 'Q' },
        { _id: '5' },
      ],
      'P',
    );
    expect(counts).toEqual({ Verde: 0, Amarillo: 1, Naranja: 0, Rojo: 1 });
    expect(alertsByLevel([{ _id: '5' }], 'PRJ-SECHURA')).toMatchObject({ Verde: 1 });
  });

  it('counts events by the first letter of their main dimension', () => {
    expect(
      eventsByDimension(
        [
          { _id: '1', Dimension_Principal: ' e – Ambiental', Proyecto_ID: 'P' },
          { _id: '2', Dimension_Principal: 'X', Proyecto_ID: 'P' },
          { _id: '3', Dimension_Principal: 'G', Proyecto_ID: 'Q' },
        ],
        'P',
      ),
    ).toEqual({ G: 0, A: 0, D: 0, N: 0, E: 1, I: 0 });
  });

  it('counts events per month over the window that ends with the latest event', () => {
    const months = eventsByMonth(
      [
        { _id: '1', Fecha: '2026-01-15', Proyecto_ID: 'P' },
        { _id: '2', Fecha: '2026-01-02', Proyecto_ID: 'P' },
        { _id: '3', Fecha: '2025-11-30', Proyecto_ID: 'P' },
        { _id: '4', Fecha: '2026-01-10', Proyecto_ID: 'Q' },
        { _id: '5', Fecha: 'sin fecha', Proyecto_ID: 'P' },
      ],
      'P',
      3,
    );
    expect(months).toEqual([
      { key: '2025-11', label: 'nov 25', value: 1 },
      { key: '2025-12', label: 'dic 25', value: 0 },
      { key: '2026-01', label: 'ene 26', value: 2 },
    ]);
    expect(eventsByMonth([{ _id: '1', Proyecto_ID: 'P' }], 'P')).toEqual([]);
  });

  it('lists the open alerts that need action first, highest band and newest first', () => {
    const items = criticalAlerts(
      [
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
        { _id: 'f', Causa: 'Otro proyecto', Nivel_Preliminar: 'Rojo', Proyecto_ID: 'Q' },
      ],
      'P',
    );
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
        { _id: '4', Descripcion_Hecho: 'Ajeno', Fecha: '2026-12-01', Proyecto_ID: 'Q' },
      ],
      'P',
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
    { _id: 'e', Descripcion_Hecho: 'Otro proyecto', Fecha: '2026-11-01', Proyecto_ID: 'Q' },
  ];

  it('counts the last seven days of the active project, newest first', () => {
    const week = eventsThisWeek(events, 'P', now, 1);
    expect(week.total).toBe(2);
    expect(week.items.map((item) => item.id)).toEqual(['a']);
  });
});
