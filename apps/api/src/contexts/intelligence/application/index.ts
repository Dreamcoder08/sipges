// Public API of the Digital Intelligence context (docs/adr/0002).
export type { AlertState, TerritorialAlert } from '../domain/index.ts';
export { ACTIONABLE_STATES } from '../domain/index.ts';
export type { AlertStore, EmbeddingProvider, NarrativeReader, Version4Lookup } from './ports.ts';
export {
  createIntelligenceService,
  type AlertCreateError,
  type AlertDecisionError,
  type IntelligenceService,
  type SemanticError,
} from './intelligence-service.ts';
