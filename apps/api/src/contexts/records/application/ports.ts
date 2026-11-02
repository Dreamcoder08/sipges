import type { VersionOperation } from '../domain/history.ts';
import type { ModuleName, Payload } from '../domain/modules.ts';

export type StoredRecord = {
  readonly id: string;
  readonly payload: Payload;
  readonly updatedAt: Date;
};

/** One stored version of a record, oldest first; `payload` is null for a deletion. */
export type StoredVersion = {
  readonly operation: VersionOperation;
  readonly payload: Payload | null;
  readonly actor: string;
  readonly at: Date;
};

/** Audit text the store writes in the same transaction as each change (app.py parity). */
export type AuditNote = {
  readonly action: 'CREATE' | 'UPDATE' | 'DELETE' | 'IMPORT';
  readonly detail: string;
};

/** Every operation runs inside one tenant transaction; `tenantId` is never trusted from input. */
export type RecordStore = {
  list(
    tenantId: string,
    module: ModuleName,
    query: { limit: number; q: string | null; offset?: number },
  ): Promise<StoredRecord[]>;
  get(tenantId: string, module: ModuleName, id: string): Promise<StoredRecord | null>;
  /** Every version of one record (also after its deletion), oldest first. */
  history(tenantId: string, module: ModuleName, id: string): Promise<StoredVersion[]>;
  /**
   * Inserts with the first free id among `candidates()` and audits it; returns the id used.
   * `candidates` yields the preferred id first, then collision fallbacks.
   */
  create(
    tenantId: string,
    module: ModuleName,
    candidates: Iterable<string>,
    payloadFor: (id: string) => Payload,
    note: AuditNote,
    at: Date,
  ): Promise<string | null>;
  /** Full replace; false when missing (nothing audited). */
  replace(
    tenantId: string,
    module: ModuleName,
    id: string,
    payload: Payload,
    note: AuditNote,
    at: Date,
  ): Promise<boolean>;
  /** Ids among `ids` that already exist in `module`. */
  existing(tenantId: string, module: ModuleName, ids: readonly string[]): Promise<Set<string>>;
  /**
   * One transaction: merges each item into its record (creating it when missing) and appends
   * one audit entry for the batch. Returns how many records were created and updated.
   */
  importBatch(
    tenantId: string,
    module: ModuleName,
    items: readonly { id: string; payload: Payload }[],
    note: AuditNote,
    at: Date,
    options?: { insertOnly: boolean },
  ): Promise<{ created: number; updated: number }>;
  /** false when missing (nothing audited). */
  remove(
    tenantId: string,
    module: ModuleName,
    id: string,
    note: AuditNote,
    at: Date,
  ): Promise<boolean>;
};

export type Clock = { now(): Date };
export type RandomHex = (length: number) => string;

/** A stored record with the type it belongs to (cross-type reads). */
export type TypedRecord = StoredRecord & { readonly module: ModuleName };

/**
 * Cross-type read for Registros «Todos», inside one tenant transaction (forced RLS also hides
 * restricted rows from limited clearance). Rows come in `modules` order, newest first within
 * each type; `counts` holds every listed type's total matching `q`, also when it is zero.
 */
export type RecordSummaryReader = {
  summary(
    tenantId: string,
    modules: readonly ModuleName[],
    query: { limit: number; offset: number; q: string | null },
  ): Promise<{ rows: TypedRecord[]; counts: ReadonlyMap<ModuleName, number> }>;
};
