import { describe, expect, it } from 'vitest';
import { isCompactField, safePublicUrl, recordPayload } from './model.ts';
import { MODULES } from './modules.ts';

describe('isCompactField', () => {
  const field = (key: string) =>
    MODULES.directorio.fields.find((f) => f.key === key) ?? { key, label: key };
  it('keeps phones and short choices on one line, lets long text wrap', () => {
    expect(isCompactField(field('Telefono'))).toBe(true);
    expect(isCompactField(field('Prioridad'))).toBe(true);
    expect(isCompactField(field('Institucion'))).toBe(false);
  });
});

describe('safePublicUrl', () => {
  it('rejects reserved .invalid hosts', () => {
    expect(safePublicUrl('https://example.invalid/mascli/1')).toBeNull();
    expect(safePublicUrl('https://example.org/x')).toBe('https://example.org/x');
  });
});

it('preserves the boolean type of an edited imported field', () => {
  const payload = recordPayload(
    'demandas',
    { Descripcion: 'Solicitud' },
    'P',
    'Proyecto',
    { _id: 'D-1', Confirmado: true },
    { Confirmado: 'false' },
  );
  expect(payload.Confirmado).toBe(false);
});
it('refuses invalid boolean and numeric edits without replacing their stored values', () => {
  const edit = (value: unknown, raw: string) =>
    recordPayload(
      'demandas',
      { Descripcion: 'Solicitud' },
      'P',
      'Proyecto',
      { _id: 'D-1', Extra: value },
      { Extra: raw },
    );
  expect(() => edit(true, 'quizás')).toThrow(/Extra/);
  expect(() => edit(12, 'no numérico')).toThrow(/Extra/);
});
