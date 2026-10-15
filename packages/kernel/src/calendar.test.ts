import { describe, expect, it } from 'vitest';
import * as calendar from './index.ts';

describe('calendar dates', () => {
  it('accepts strict real Gregorian dates without rollover', () => {
    expect(calendar.isValidCalendarDate).toBeTypeOf('function');
    for (const value of ['2024-02-29', '2000-02-29', '2026-10-15'])
      expect(calendar.isValidCalendarDate(value)).toBe(true);
    for (const value of [
      '',
      '2025-02-29',
      '1900-02-29',
      '2026-04-31',
      '0000-01-01',
      '2026-1-01',
      ' 2026-10-15',
      '2026-10-15T00:00:00Z',
      null,
    ])
      expect(calendar.isValidCalendarDate(value)).toBe(false);
  });
  it('normalizes terminal statuses without treating Incumplido as complete', () => {
    expect(calendar.isTerminalStatus).toBeTypeOf('function');
    for (const value of [
      ' Cumplida ',
      'COMPLETADO',
      'Cerrada',
      'Cancelado',
      'Atendida',
      'Resuelto',
      'Finalizada',
    ])
      expect(calendar.isTerminalStatus(value)).toBe(true);
    expect(calendar.normalizeSpanishStatus('  EN   REVISIÓN ')).toBe('en revision');
    expect(calendar.isTerminalStatus('Incumplido')).toBe(false);
    expect(calendar.isCompletedStatus('Cumplido')).toBe(true);
    expect(calendar.isCompletedStatus('Cancelada')).toBe(false);
  });
  it('uses Lima calendar day at the UTC boundary', () => {
    expect(calendar.limaToday).toBeTypeOf('function');
    expect(calendar.limaToday(new Date('2026-10-15T03:00:00Z'))).toBe('2026-10-14');
    expect(calendar.limaToday(new Date('2026-10-15T05:00:00Z'))).toBe('2026-10-15');
  });
  it('respects date precedence and never interprets textual deadlines', () => {
    expect(calendar.recordDueDate).toBeTypeOf('function');
    expect(
      calendar.recordDueDate({
        Fecha_Vencimiento: '2026-10-15',
        Fecha_Limite: '2026-10-16',
        Plazo: '2026-10-17',
      }),
    ).toBe('2026-10-15');
    expect(
      calendar.recordDueDate({ Fecha_Vencimiento: '2026-02-30', Plazo: '2026-10-17' }),
    ).toBeNull();
    expect(calendar.recordDueDate({ Fecha_Limite: '2026-10-16' })).toBe('2026-10-16');
    expect(calendar.recordDueDate({ Plazo: '2026-10-17' })).toBe('2026-10-17');
    expect(calendar.recordDueDate({ Plazo: '30 días después de la reunión' })).toBeNull();
  });
});

it('honors explicit cleared dates instead of reviving imported aliases or ISO Plazo', () => {
  for (const cleared of ['', null, undefined, ' ']) {
    expect(
      calendar.recordDueDate({
        Fecha_Vencimiento: cleared,
        Fecha_Limite: '2020-01-02',
        Plazo: '2020-01-03',
      }),
    ).toBeNull();
    expect(calendar.recordDueDate({ Fecha_Limite: cleared, Plazo: '2020-01-03' })).toBeNull();
  }
  expect(calendar.recordDueDate({ Fecha_Limite: '2020-01-02', Plazo: '2020-01-03' })).toBe(
    '2020-01-02',
  );
});
