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
  /** Who recorded the entry; null on entries written before receipts existed. */
  readonly decidedBy: string | null;
  readonly receipt: DecisionReceipt | null;
};

/** MASCLI 4.0 (docs/adr/0023): the evidence file behind a decision, frozen with its hash. */
export type DecisionReceipt = {
  readonly attachmentId: string;
  readonly fileName: string;
  readonly sha256: string;
};

/** MASCLI 4.0 situation room: who an action is waiting on (docs/adr/0024 §2). */
export const BLOCKERS = ['Comunidad', 'Autoridad', 'Área interna', 'Contratista', 'Otro'] as const;
export type Blocker = (typeof BLOCKERS)[number];
export const isBlocker = (value: string): value is Blocker =>
  (BLOCKERS as readonly string[]).includes(value);

export type ActionBlock = {
  readonly by: Blocker;
  readonly reason: string;
  readonly since: Date;
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
  readonly block?: ActionBlock | null;
};

export type ActionUpdate = {
  readonly status: string;
  readonly progress: number;
  readonly note: string;
  readonly evidenceUrl: string;
  /** Attached evidence file id; '' when none. Only read with MASCLI 4.0 on. */
  readonly evidenceAttachmentId: string;
  /** Who the action waits on; '' clears it, undefined leaves it. Only read with MASCLI 4.0 on. */
  readonly blockedBy?: string | undefined;
  readonly blockedReason?: string | undefined;
};

export type UpdateRejection =
  | { readonly kind: 'status' }
  | { readonly kind: 'completed_progress' }
  | { readonly kind: 'pending_progress' }
  | { readonly kind: 'evidence_url' }
  | { readonly kind: 'reactivate' }
  | { readonly kind: 'note_required' }
  | { readonly kind: 'evidence_required' }
  | { readonly kind: 'evidence_missing' }
  | { readonly kind: 'blocker' };

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

/**
 * MASCLI 4.0: completing a plan claims the risk was addressed, so it needs a receipt (an
 * attached evidence file). Progress and cancellation stay as they were.
 */
export const checkReceipt = (status: ActionStatus, attachmentId: string): UpdateRejection | null =>
  status === 'Completada' && !attachmentId ? { kind: 'evidence_required' } : null;

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

/**
 * MASCLI 4.0 situation room: active plans that wait on someone, overdue ones and the count of
 * those moving normally, so nobody has to ask for a status report.
 */
export const situationRoom = (actions: readonly PreventiveAction[], today: string) => {
  const active = actions.filter(isActive);
  const blocked = active.filter((a) => a.block);
  const overdue = active.filter((a) => !a.block && isOverdue(a, today));
  const count: Partial<Record<Blocker, number>> = {};
  for (const a of blocked) if (a.block) count[a.block.by] = (count[a.block.by] ?? 0) + 1;
  return {
    blocked,
    overdue,
    moving: active.length - blocked.length - overdue.length,
    blockedByCount: count,
  };
};
