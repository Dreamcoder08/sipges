// Public API of the Audit context: the tenant audit trail. Writes that must commit with a
// business change happen inside the owning context's tenant transaction through
// platform/database/audit-trail.ts; standalone entries (e.g. outbound sends) use AuditWriter.

export type AuditRecord = {
  readonly id: number;
  readonly at: Date;
  readonly module: string;
  readonly recordId: string | null;
  readonly action: string;
  readonly detail: string | null;
};

export type AuditReader = {
  latest(tenantId: string, limit: number): Promise<AuditRecord[]>;
  /** Entries after `afterId`, oldest first: the live activity feed (docs/adr/0014 §10). */
  after(tenantId: string, afterId: number, limit: number): Promise<AuditRecord[]>;
  /** The newest entry id, or 0 for an empty trail. */
  lastId(tenantId: string): Promise<number>;
};

/** One standalone audit entry; the detail must carry no message bodies, names or secrets. */
export type AuditEntryInput = {
  readonly module: string;
  readonly recordId: string | null;
  readonly action: string;
  readonly detail: string;
  readonly at: Date;
};

/** Appends one entry to the trail of `tenantId`, in its own tenant transaction. */
export type AuditWriter = {
  append(tenantId: string, entry: AuditEntryInput): Promise<void>;
};

/** Absolute ceiling for audit pages (docs/adr/0008 #10). */
export const MAX_AUDIT_LIMIT = 500;

export const createAuditService = (reader: AuditReader) => ({
  latest: (tenantId: string, limit: number) =>
    reader.latest(tenantId, limit < 0 ? MAX_AUDIT_LIMIT : Math.min(limit, MAX_AUDIT_LIMIT)),
  after: (tenantId: string, afterId: number, limit: number) =>
    reader.after(tenantId, afterId, Math.min(limit, MAX_AUDIT_LIMIT)),
  lastId: (tenantId: string) => reader.lastId(tenantId),
});

export type AuditService = ReturnType<typeof createAuditService>;
