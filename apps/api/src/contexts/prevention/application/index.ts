// Public API of the Prevention context (docs/adr/0002).
export type { ActionStatus, PreventiveAction } from '../domain/index.ts';
export {
  averageProgress,
  completionPercent,
  isActive,
  isCalendarDate,
  isOverdue,
} from '../domain/index.ts';
export type { ActionStore, AlertLookup } from './ports.ts';
export {
  createPreventionService,
  type CreateError,
  type PreventionService,
  type UpdateError,
} from './prevention-service.ts';
