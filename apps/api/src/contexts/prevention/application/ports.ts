import type { Scope } from '../../tenancy/application/index.ts';
import type { ActionLogEntry, DecisionReceipt, PreventiveAction } from '../domain/index.ts';

export type Clock = { now(): Date };
export type RandomHex = (length: number) => string;

/** Status of a territorial alert of the scope (Digital Intelligence context), null if missing. */
export type AlertLookup = { status(scope: Scope, alertId: string): Promise<string | null> };

/** Evidence file of the scope (Evidence context), null if missing. */
export type EvidenceLookup = {
  find(scope: Scope, attachmentId: string): Promise<DecisionReceipt | null>;
};

/** Whether the scope's project has MASCLI 4.0 switched on (Situations context). */
export type Version4Lookup = { enabled(scope: Scope): Promise<boolean> };

export type NewAction = Omit<PreventiveAction, 'history' | 'status' | 'progress' | 'updatedAt'>;

export type ActionStore = {
  /** Inserts the plan, its first log entry and the CREATE audit row in one transaction. */
  create(tenantId: string, action: NewAction, logId: string): Promise<PreventiveAction>;
  list(tenantId: string, projectId: string): Promise<PreventiveAction[]>;
  get(tenantId: string, id: string): Promise<PreventiveAction | null>;
  /**
   * Applies an update with its log entry and UPDATE audit row. `guard` runs on the row
   * locked for update and may refuse the change; null when the action is missing.
   */
  update<E>(
    tenantId: string,
    id: string,
    guard: (current: PreventiveAction) => E | null,
    change: Omit<ActionLogEntry, 'actionId' | 'evidenceUrl' | 'decidedBy'> & {
      evidenceUrl: string;
      decidedBy: string;
    },
  ): Promise<{ ok: true; action: PreventiveAction } | { ok: false; error: E } | null>;
};
