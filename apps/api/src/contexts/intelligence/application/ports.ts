import type { SanitisedPayload } from '../../privacy/application/index.ts';
import type { Scope } from '../../tenancy/application/index.ts';
import type { AlertState, TerritorialAlert } from '../domain/index.ts';

export type Clock = { now(): Date };
export type RandomHex = (length: number) => string;

/** Payloads of the scope's `Narrativas` records, newest first. */
export type NarrativeReader = {
  read(scope: Scope): Promise<readonly Readonly<Record<string, unknown>>[]>;
};

/**
 * Text embeddings from a model (Ollama, local by default). Throws when the model is not
 * reachable or returns no usable vector; callers fall back to rules or answer 503. Text sent to
 * a model that is not on this machine (`egress: 'external'`) is cleared by the egress guard
 * first (docs/adr/0030); the payload type makes that the only way to call `embed`.
 */
export type EmbeddingProvider = {
  readonly model: string;
  /** `local`: loopback, not egress. Anything else is treated as external. */
  readonly egress: 'local' | 'external';
  embed(text: SanitisedPayload<string>): Promise<number[]>;
};

/** Whether the project switched external AI on (privacy context, docs/adr/0030). */
export type ExternalAiSwitch = { enabled(tenantId: string): Promise<boolean> };

export type NewAlert = Omit<TerritorialAlert, 'reviewerNote' | 'reviewedAt' | 'status'>;

export type AlertStore = {
  /** Inserts the alert and its CREATE audit row in one tenant transaction. */
  create(tenantId: string, alert: NewAlert): Promise<TerritorialAlert & { duplicate?: boolean }>;
  list(tenantId: string, query: { projectId: string; limit: number }): Promise<TerritorialAlert[]>;
  get(tenantId: string, id: string): Promise<TerritorialAlert | null>;
  /** Updates the status and writes the REVIEW audit row; false when the alert is missing. */
  decide(
    tenantId: string,
    decision: { id: string; status: AlertState; note: string; at: Date },
  ): Promise<boolean>;
  /** SIPGES: records the first of two validations without changing the status. */
  recordFirstValidation(
    tenantId: string,
    validation: { id: string; actor: string; note: string; at: Date },
  ): Promise<boolean>;
};
