import { roundHalfEven } from '@mascli/kernel';

/** Preventive action plans that follow verified alerts (app.py:2133-2216, RC 2.7). */

export const ACTION_STATUSES = ['Pendiente', 'En ejecución', 'Completada', 'Cancelada'] as const;
export type ActionStatus = (typeof ACTION_STATUSES)[number];

const CLOSED: readonly ActionStatus[] = ['Completada', 'Cancelada'];

export type ActionLogEntry = {
  readonly id: string;
  readonly actionId: string;
  readonly createdAt: Date;
  readonly status: ActionStatus;
  readonly progress: number;
  readonly note: string;
  readonly evidenceUrl: string | null;
};

export type PreventiveAction = {
  readonly id: string;
  readonly projectId: string;
  readonly alertId: string;
  readonly title: string;
  readonly responsible: string;
  /** Calendar date `YYYY-MM-DD`. */
  readonly dueDate: string;
  readonly description: string;
  readonly status: ActionStatus;
  readonly progress: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly history: readonly ActionLogEntry[];
};

export type ActionUpdate = {
  readonly status: string;
  readonly progress: number;
  readonly note: string;
  readonly evidenceUrl: string;
};

export type UpdateRejection =
  | { readonly kind: 'status' }
  | { readonly kind: 'completed_progress' }
  | { readonly kind: 'pending_progress' }
  | { readonly kind: 'evidence_url' }
  | { readonly kind: 'reactivate' }
  | { readonly kind: 'note_required' };

const isStatus = (value: string): value is ActionStatus =>
  (ACTION_STATUSES as readonly string[]).includes(value);

/** Checks that need no stored state, in app.py order. */
export const checkUpdate = (
  update: ActionUpdate,
): { ok: true; status: ActionStatus } | { ok: false; error: UpdateRejection } => {
  if (!isStatus(update.status)) return { ok: false, error: { kind: 'status' } };
  if (update.status === 'Completada' && update.progress !== 100)
    return { ok: false, error: { kind: 'completed_progress' } };
  if (update.status === 'Pendiente' && update.progress > 0)
    return { ok: false, error: { kind: 'pending_progress' } };
  if (update.evidenceUrl && !/^https?:\/\//i.test(update.evidenceUrl))
    return { ok: false, error: { kind: 'evidence_url' } };
  return { ok: true, status: update.status };
};

/** Checks against the stored action: a cancelled plan stays cancelled; closing needs a reason. */
export const checkTransition = (
  current: ActionStatus,
  next: ActionStatus,
  note: string,
): UpdateRejection | null => {
  if (current === 'Cancelada' && next !== 'Cancelada') return { kind: 'reactivate' };
  if (CLOSED.includes(next) && !note.trim()) return { kind: 'note_required' };
  return null;
};

export const isActive = (action: Pick<PreventiveAction, 'status'>) =>
  !CLOSED.includes(action.status);

/** Overdue: still active and due strictly before `today` (`YYYY-MM-DD` strings compare). */
export const isOverdue = (action: Pick<PreventiveAction, 'status' | 'dueDate'>, today: string) =>
  isActive(action) && action.dueDate < today;

export const completionPercent = (actions: readonly Pick<PreventiveAction, 'status'>[]) =>
  actions.length
    ? roundHalfEven(
        (actions.filter((a) => a.status === 'Completada').length * 100) / actions.length,
        1,
      )
    : 0;

export const averageProgress = (actions: readonly Pick<PreventiveAction, 'progress'>[]) =>
  actions.length
    ? roundHalfEven(actions.reduce((n, a) => n + a.progress, 0) / actions.length, 1)
    : 0;

export const preventionSummary = (
  projectId: string,
  actions: readonly PreventiveAction[],
  today: string,
) => ({
  project_id: projectId,
  total: actions.length,
  active: actions.filter(isActive).length,
  overdue: actions.filter((a) => isOverdue(a, today)).length,
  completed: actions.filter((a) => a.status === 'Completada').length,
  completion_percent: completionPercent(actions),
  average_progress: averageProgress(actions),
  irsa_modified: false,
  notice:
    'Métricas operativas de acciones; no equivalen a una disminución validada del riesgo social.',
});

/** A real calendar date in `YYYY-MM-DD` form (pydantic `date`). */
export const isCalendarDate = (value: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
};
