import { type Result, err, ok } from '@mascli/kernel';
import { type Scope, formatScope } from '../../tenancy/application/index.ts';
import {
  type ActionUpdate,
  type PreventiveAction,
  type UpdateRejection,
  checkTransition,
  checkUpdate,
  preventionSummary,
} from '../domain/index.ts';
import type { ActionStore, AlertLookup, Clock, RandomHex } from './ports.ts';

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
  clock: Clock;
  randomHex: RandomHex;
}) => {
  const { store, alerts, clock, randomHex } = deps;
  const today = () => clock.now().toISOString().slice(0, 10);
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
    ): Promise<Result<PreventiveAction, UpdateError>> {
      const checked = checkUpdate(update);
      if (!checked.ok) return err(checked.error);
      if (id.length > 80) return err({ kind: 'missing' });
      const result = await store.update(
        formatScope(scope),
        id,
        (current) => checkTransition(current.status, checked.status, update.note),
        {
          id: randomHex(32).toLowerCase(),
          createdAt: clock.now(),
          status: checked.status,
          progress: update.progress,
          note: update.note,
          evidenceUrl: update.evidenceUrl,
        },
      );
      if (result === null) return err({ kind: 'missing' });
      return result.ok ? ok(result.action) : err(result.error);
    },

    async summary(scope: Scope) {
      return preventionSummary(scope.projectId, await list(scope), today());
    },

    today,
  };
};

export type PreventionService = ReturnType<typeof createPreventionService>;
