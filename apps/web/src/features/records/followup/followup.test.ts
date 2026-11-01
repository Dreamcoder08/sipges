import type { ModuleRecord } from '@sipges/contracts';
import { expect, it } from 'vitest';
import * as followup from './followup.ts';

it('groups active records by real dates and retains record identity', () => {
  expect(followup.followupRows).toBeTypeOf('function');
  const rows: ModuleRecord[] = [
    { _id: 'late', Estado: 'Incumplido', Plazo: '2026-10-14', Responsable: 'Equipo' },
    { _id: 'today', Fecha_Limite: '2026-10-15' },
    { _id: 'future', Fecha_Vencimiento: '2026-10-16' },
    { _id: 'text', Plazo: 'En la próxima reunión' },
    { _id: 'invalid', Fecha_Vencimiento: '2026-02-30', Plazo: '2026-10-16' },
    { _id: 'done', Estado: ' ATENDIDA ', Plazo: '2026-10-14' },
  ];
  const result = followup.followupRows(rows, '2026-10-15');
  expect(result.map((r) => r.bucket)).toEqual([
    'overdue',
    'today',
    'upcoming',
    'undated',
    'undated',
    'closed',
  ]);
  expect(result[0]?.row).toBe(rows[0]);
  expect(result[3]?.rawDeadline).toBe('En la próxima reunión');
  expect(result[0]?.unassigned).toBe(false);
  expect(result[1]?.unassigned).toBe(true);
});

it('keeps cleared canonical deadlines undated and hides inactive aliases', () => {
  const entries = followup.followupRows(
    [
      { _id: 'cleared', Fecha_Vencimiento: '', Fecha_Limite: '2020-01-02', Plazo: '2020-01-03' },
      { _id: 'null', Fecha_Vencimiento: null, Fecha_Limite: '2020-01-02' },
      { _id: 'alias-clear', Fecha_Limite: '', Plazo: '2020-01-03' },
      { _id: 'imported', Fecha_Limite: '2020-01-02' },
    ],
    '2026-10-15',
  );
  expect(entries.map((entry) => entry.bucket)).toEqual([
    'undated',
    'undated',
    'undated',
    'overdue',
  ]);
  expect(entries.map((entry) => entry.rawDeadline)).toEqual(['', '', '', '2020-01-02']);
});
