// Public API of the Privacy context (docs/adr/0030): the guard every path that sends tenant
// data to an external model or client must go through.
export {
  EXTERNAL_AI_DISABLED,
  type EgressChannel,
  type EgressGuard,
  type EgressRequest,
  type EgressSession,
  type OpenResult,
  createEgressGuard,
  exemptPayload,
} from './egress-guard.ts';
export type {
  Clock,
  EgressLog,
  EgressLogEntry,
  ExternalAiSwitch,
  NameDirectory,
  PseudonymKeys,
} from './ports.ts';
export type { SanitisedPayload } from '../domain/sanitised.ts';
export type { RawRecord, SanitisedRecord } from '../domain/sanitise.ts';
export type { KnownName, Mac, PseudonymKind } from '../domain/pseudonyms.ts';
