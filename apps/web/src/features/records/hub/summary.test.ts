import { expect, it } from 'vitest';
import { summarize, verificationLetter } from './summary.ts';

it('reads the A–E letter from a verification label, and nothing from other wording', () => {
  expect(verificationLetter('B - Corroborada')).toBe('B');
  expect(verificationLetter('E - No verificada')).toBe('E');
  expect(verificationLetter('Por verificar')).toBeNull();
  expect(verificationLetter('')).toBeNull();
});

it('summarises a record of any type for the shared list', () => {
  expect(
    summarize('eventos', {
      _id: 'E-1',
      Fecha: '2026-10-28',
      Territorio: 'Bayóvar',
      Descripcion_Hecho: 'Bloqueo del muelle',
      Nivel_Verificacion: 'B - Corroborada',
      Estado_Validacion: 'Validado',
    }),
  ).toEqual({
    module: 'eventos',
    id: 'E-1',
    title: 'Bloqueo del muelle',
    territory: 'Bayóvar',
    date: '2026-10-28',
    verification: 'B',
    validation: 'Validado',
  });
  expect(summarize('actores', { _id: 'A-1' })).toMatchObject({
    title: 'A-1',
    territory: '',
    verification: null,
    validation: '',
  });
});
