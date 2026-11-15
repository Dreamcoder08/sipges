import { expect, it } from 'vitest';
import { recordFieldLabel } from './modules.ts';

// functional-10 T3 (F8): a stored field reads as the record form names it, never as its key.
it.each([
  ['eventos', 'Descripcion_Hecho', 'Descripción del hecho'],
  ['eventos', 'Nivel_Verificacion', 'Verificación'],
  ['eventos', 'Fuente_ID', 'Referencia de fuente'],
  ['alertas', 'Nivel_Preliminar', 'Nivel preliminar'],
  ['alertas', 'Accion_Sugerida', 'Acción sugerida'],
  ['demandas', 'Fecha_Registro', 'Fecha de registro'],
  ['actores', 'Nombre_Actor/Organizacion', 'Nombre del actor u organización'],
  ['actores', 'Posicion_Proyecto', 'Posición frente al proyecto'],
  // An alias reads as the field it stands for.
  ['acciones', 'Fecha_Limite', 'Fecha límite'],
  // A key no form declares still reads as words.
  ['actores', 'Fuente_Principal', 'Fuente principal'],
  ['eventos', 'Evidencia/Resultado', 'Evidencia / resultado'],
] as const)('%s %s → %s', (module, key, label) => {
  expect(recordFieldLabel(module, key)).toBe(label);
});
