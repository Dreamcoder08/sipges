import type { ModuleRecord } from '@sipges/contracts';
import { isTerminalStatus, limaToday, recordDueDate } from '@sipges/kernel';

export type FollowupBucket = 'overdue' | 'today' | 'upcoming' | 'undated' | 'closed';
export const followupRows = (rows: readonly ModuleRecord[], today = limaToday()) =>
  rows.map((row) => {
    const dueDate = recordDueDate(row);
    const deadlineKey = ['Fecha_Vencimiento', 'Fecha_Limite', 'Plazo'].find((key) =>
      Object.hasOwn(row, key),
    );
    const raw = deadlineKey === undefined ? undefined : row[deadlineKey];
    const bucket: FollowupBucket = isTerminalStatus(row.Estado)
      ? 'closed'
      : !dueDate
        ? 'undated'
        : dueDate < today
          ? 'overdue'
          : dueDate === today
            ? 'today'
            : 'upcoming';
    return {
      row,
      dueDate,
      bucket,
      rawDeadline: raw == null ? '' : String(raw),
      unassigned: row.Responsable == null || String(row.Responsable).trim() === '',
    };
  });
