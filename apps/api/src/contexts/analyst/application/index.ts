// Public API of the Analyst context (docs/adr/0013).
export type {
  Briefing,
  Connection,
  Section,
  Sentence,
  Source,
  Subject,
} from '../domain/briefing.ts';
export type { BriefingSource, Narrator } from './ports.ts';
export {
  type AnalystService,
  type BriefingResult,
  NARRATION_TIMEOUT_MS,
  createAnalystService,
} from './analyst-service.ts';
