import { describe, expect, it } from 'vitest';
import { alertsByLevel, eventsByDimension } from './model.ts';

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
});
