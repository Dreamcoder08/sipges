import type { Scope } from '../../tenancy/application/index.ts';
import type { AlertState, TerritorialAlert } from '../domain/index.ts';

export type Clock = { now(): Date };
export type RandomHex = (length: number) => string;

/** Payloads of the scope's `Narrativas` records, newest first. */
export type NarrativeReader = {
  read(scope: Scope): Promise<readonly Readonly<Record<string, unknown>>[]>;
};

/**
 * Text embeddings from a local model (Ollama by default). Throws when the model is not
 * reachable or returns no usable vector; callers fall back to rules or answer 503.
 */
export type EmbeddingProvider = {
  readonly model: string;
  embed(text: string): Promise<number[]>;
};

export type NewAlert = Omit<TerritorialAlert, 'reviewerNote' | 'reviewedAt' | 'status'>;

export type AlertStore = {
  /** Inserts the alert and its CREATE audit row in one tenant transaction. */
  create(tenantId: string, alert: NewAlert): Promise<TerritorialAlert>;
  list(tenantId: string, query: { projectId: string; limit: number }): Promise<TerritorialAlert[]>;
  get(tenantId: string, id: string): Promise<TerritorialAlert | null>;
  /** Updates the status and writes the REVIEW audit row; false when the alert is missing. */
  decide(
    tenantId: string,
    decision: { id: string; status: AlertState; note: string; at: Date },
  ): Promise<boolean>;
};
