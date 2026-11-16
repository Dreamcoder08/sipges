import { recordDueDate } from '@sipges/kernel';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isCompactField, safePublicUrl, recordPayload, initialValues } from './model.ts';
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

describe('initialValues', () => {
  afterEach(() => vi.useRealTimers());
  it('dates a new record on the Lima calendar day, not the UTC one', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    // 23:30 in Lima (UTC−5) is already 04:30 of the next day in UTC.
    vi.setSystemTime(new Date('2026-11-13T23:30:00-05:00'));
    expect(initialValues('buzon').Fecha).toBe('2026-11-13');
  });
});

describe('safePublicUrl', () => {
  it('rejects reserved .invalid hosts', () => {
    expect(safePublicUrl('https://example.invalid/sipges/1')).toBeNull();
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

it('does not invent a deadline or influence for a new record', () => {
  expect(initialValues('acciones').Fecha_Vencimiento).toBe('');
  expect(initialValues('compromisos').Fecha_Vencimiento).toBe('');
  expect(initialValues('actores').Influencia).toBe('');
});

it('preserves a date-only original deadline when saving a different field', () => {
  const original = {
    _id: 'C-DATE',
    Descripcion: 'Compromiso de prueba',
    Plazo: '2020-01-02',
    Responsable: 'Anterior',
  };
  const values = {
    ...initialValues('compromisos', original),
    Responsable: 'Responsable actualizado',
  };
  const saved = recordPayload('compromisos', values, 'PRJ-TEST', 'Proyecto', original);
  expect(recordDueDate(saved)).toBe('2020-01-02');
  expect(saved.Plazo).toBe('2020-01-02');
});
