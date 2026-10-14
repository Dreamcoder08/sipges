// Public API of the Analyst context (docs/adr/0013).
export type {
  Briefing,
  Connection,
  Section,
  Sentence,
  Source,
  Subject,
} from '../domain/briefing.ts';
export type { MentionFound, Proposal, ProposedLink, ProposedRecord } from '../domain/proposals.ts';
export type {
  BriefingSource,
  Narrator,
  ProposalActions,
  ProposalDecision,
  ProposalStore,
} from './ports.ts';
export {
  type AnalystService,
  type BriefingResult,
  type DecideError,
  NARRATION_TIMEOUT_MS,
  createAnalystService,
} from './analyst-service.ts';
