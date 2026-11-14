import { type Result, err, limaToday, ok } from '@sipges/kernel';
import { type Scope, formatScope } from '../../tenancy/application/index.ts';
import {
  type ActionUpdate,
  type PreventiveAction,
  type UpdateRejection,
  checkReceipt,
  checkTransition,
  checkUpdate,
  isBlocker,
  preventionSummary,
  situationRoom,
} from '../domain/index.ts';
import type { ActionStore, AlertLookup, Clock, EvidenceLookup, RandomHex } from './ports.ts';

/** Alerts a plan may follow: verified by a person first (app.py:2163-2167). */
const ACTIONABLE = new Set(['Corroborado', 'En seguimiento']);

export type CreateError =
  { readonly kind: 'alert_missing' } | { readonly kind: 'alert_unverified' };
export type UpdateError = UpdateRejection | { readonly kind: 'missing' };

export type NewPlan = {
  readonly alertId: string;
  readonly title: string;
  readonly responsible: string;
  readonly dueDate: string;
  readonly description: string;
};

export const createPreventionService = (deps: {
  store: ActionStore;
  alerts: AlertLookup;
  evidence: EvidenceLookup;
  clock: Clock;
  randomHex: RandomHex;
}) => {
  const { store, alerts, evidence, clock, randomHex } = deps;
  const today = () => limaToday(clock.now());
  const list = (scope: Scope) => store.list(formatScope(scope), scope.projectId);

  return {
    async create(scope: Scope, plan: NewPlan): Promise<Result<PreventiveAction, CreateError>> {
      const status = await alerts.status(scope, plan.alertId);
      if (status === null) return err({ kind: 'alert_missing' });
      if (!ACTIONABLE.has(status)) return err({ kind: 'alert_unverified' });
      const at = clock.now();
      return ok(
        await store.create(
          formatScope(scope),
          {
            id: `PREV-${randomHex(12).toUpperCase()}`,
            projectId: scope.projectId,
            alertId: plan.alertId,
            title: plan.title,
            responsible: plan.responsible,
            dueDate: plan.dueDate,
            description: plan.description,
            createdAt: at,
          },
          randomHex(32).toLowerCase(),
        ),
      );
    },

    list,

    async update(
      scope: Scope,
      id: string,
      update: ActionUpdate,
      actor: string,
    ): Promise<Result<PreventiveAction, UpdateError>> {
      const checked = checkUpdate(update);
      if (!checked.ok) return err(checked.error);
      if (id.length > 80) return err({ kind: 'missing' });
      const attachmentId = update.evidenceAttachmentId.trim();
      const required = checkReceipt(checked.status, attachmentId);
      if (required) return err(required);
      const receipt = attachmentId ? await evidence.find(scope, attachmentId) : null;
      if (attachmentId && !receipt) return err({ kind: 'evidence_missing' });
      const blockedBy = update.blockedBy?.trim();
      if (blockedBy && !isBlocker(blockedBy)) return err({ kind: 'blocker' });
      const now = clock.now();
      // A closed plan waits on nobody; '' clears the blocker; absent leaves it as it was.
      const closing = checked.status === 'Completada' || checked.status === 'Cancelada';
      const block = closing
        ? null
        : blockedBy === undefined
          ? undefined
          : blockedBy && isBlocker(blockedBy)
            ? { by: blockedBy, reason: update.blockedReason?.trim() ?? '', since: now }
            : null;
      const result = await store.update(
        formatScope(scope),
        id,
        (current) => checkTransition(current.status, checked.status, update.note),
        {
          id: randomHex(32).toLowerCase(),
          createdAt: now,
          status: checked.status,
          progress: update.progress,
          note: update.note,
          evidenceUrl: update.evidenceUrl,
          decidedBy: actor,
          receipt,
          block,
        },
      );
      if (result === null) return err({ kind: 'missing' });
      return result.ok ? ok(result.action) : err(result.error);
    },

    async situationRoom(scope: Scope) {
      return situationRoom(await list(scope), today());
    },

    async summary(scope: Scope) {
      return preventionSummary(scope.projectId, await list(scope), today());
    },

    today,
  };
};

export type PreventionService = ReturnType<typeof createPreventionService>;
