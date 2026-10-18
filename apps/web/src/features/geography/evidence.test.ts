import { describe, expect, it } from 'vitest';
import { evidenceOf } from './evidence.ts';

describe('information state', () => {
  it('observes only verified records with a source', () => {
    expect(evidenceOf({ Nivel_Verificacion: 'B - Corroborada', Fuente_ID: 'F-1' }).state).toBe(
      'observado',
    );
    expect(evidenceOf({ Nivel_Verificacion: 'B - Corroborada' })).toEqual({
      state: 'estimado',
      basis: 'Falta referencia de fuente',
    });
    expect(evidenceOf({ Nivel_Verificacion: 'E - No verificada', Fuente_ID: 'F-1' }).state).toBe(
      'estimado',
    );
  });

  it('honours declared scenarios and estimates but not unsupported observations', () => {
    expect(evidenceOf({ Estado_Informacion: 'Escenario hipotético' }).state).toBe('escenario');
    expect(
      evidenceOf({
        Estado_Informacion: 'Estimado',
        Nivel_Verificacion: 'A - Confirmada',
        Fuente_ID: 'F-1',
      }).state,
    ).toBe('estimado');
    expect(evidenceOf({ Estado_Informacion: 'Observado' })).toEqual({
      state: 'estimado',
      basis: 'Declarado observado, pero falta verificación A–C y referencia de fuente',
    });
  });

  it('never infers a scenario', () => {
    expect(evidenceOf({ Descripcion_Hecho: 'Posible escenario de protesta' }).state).toBe(
      'estimado',
    );
  });
});
