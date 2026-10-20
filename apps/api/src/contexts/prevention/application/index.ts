// Public API of the Prevention context (docs/adr/0002).
export type { ActionStatus, Blocker, DecisionReceipt, PreventiveAction } from '../domain/index.ts';
export {
  BLOCKERS,
  averageProgress,
  completionPercent,
  isActive,
  isCalendarDate,
  isOverdue,
} from '../domain/index.ts';
export type { ActionStore, AlertLookup, EvidenceLookup, Version4Lookup } from './ports.ts';
export {
  createPreventionService,
  type CreateError,
  type PreventionService,
  type UpdateError,
} from './prevention-service.ts';
