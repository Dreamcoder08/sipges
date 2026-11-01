import type { RecordVersion } from '@sipges/contracts';
import { expect, it } from 'vitest';
import { traceability } from './HistoryPanel.tsx';

const version = (
  n: number,
  operation: RecordVersion['operation'],
  actor: string,
  changes: RecordVersion['changes'] = [],
): RecordVersion => ({
  version: n,
  operation,
  actor,
  at: `2026-10-1${n}T12:00:00Z`,
  payload: {},
  changes,
});

it('names who registered, reviewed and last changed a record', () => {
  const versions = [
    version(3, 'UPDATE', 'carla', [{ field: 'Descripcion', before: 'a', after: 'b' }]),
    version(2, 'UPDATE', 'beto', [
      { field: 'Estado_Validacion', before: 'Pendiente', after: 'Validado' },
    ]),
    version(1, 'CREATE', 'ana'),
  ];
  const trace = traceability(versions);
  expect(trace.origin?.actor).toBe('ana');
  expect(trace.review?.actor).toBe('beto');
  expect(trace.latest?.actor).toBe('carla');
  expect(traceability([version(1, 'CREATE', 'ana')])).toEqual({
    origin: versions[2],
    latest: undefined,
    review: undefined,
  });
});
