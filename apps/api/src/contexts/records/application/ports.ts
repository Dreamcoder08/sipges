import type { ModuleName, Payload } from '../domain/modules.ts';

export type StoredRecord = {
  readonly id: string;
  readonly payload: Payload;
  readonly updatedAt: Date;
};

/** Audit text the store writes in the same transaction as each change (app.py parity). */
export type AuditNote = {
  readonly action: 'CREATE' | 'UPDATE' | 'DELETE';
  readonly detail: string;
};

/** Every operation runs inside one tenant transaction; `tenantId` is never trusted from input. */
export type RecordStore = {
  list(
    tenantId: string,
    module: ModuleName,
    query: { limit: number; q: string | null },
  ): Promise<StoredRecord[]>;
  get(tenantId: string, module: ModuleName, id: string): Promise<StoredRecord | null>;
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
