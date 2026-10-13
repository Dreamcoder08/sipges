/** Ports of the legacy migration tool: reading the old installation and writing the new one. */
import type { ObjectStorage } from '../../../contexts/evidence/application/index.ts';
import type {
  LegacyActionLogRow,
  LegacyActionRow,
  LegacyAlertRow,
  LegacyAttachmentRow,
  LegacyAuditRow,
  LegacyDocumentReviewRow,
  LegacyRecordRow,
  LegacyScope,
  LegacySnapshotRow,
  LegacyUserRow,
  TableCounts,
  TenantTable,
} from '../domain/legacy.ts';
import type {
  TargetAction,
  TargetActionLog,
  TargetAlert,
  TargetAttachment,
  TargetAudit,
  TargetDocumentReview,
  TargetGrant,
  TargetRecord,
  TargetSnapshot,
  TargetTenant,
  TargetUser,
} from '../domain/mapping.ts';

export type { ObjectStorage };

export type LegacyGrantRow = { readonly username: string; readonly scope: LegacyScope };

/** One legacy tenant database plus its JSON settings and upload root (read-only). */
export type LegacyTenantReader = {
  readonly scope: LegacyScope;
  readonly tenantId: string;
  /** false when the SQLite file does not exist (a directory entry without data). */
  readonly present: boolean;
  records(): Promise<readonly LegacyRecordRow[]>;
  audit(): Promise<readonly LegacyAuditRow[]>;
  snapshots(): Promise<readonly LegacySnapshotRow[]>;
  attachments(): Promise<readonly LegacyAttachmentRow[]>;
  documentReviews(): Promise<readonly LegacyDocumentReviewRow[]>;
  alerts(): Promise<readonly LegacyAlertRow[]>;
  actions(): Promise<readonly LegacyActionRow[]>;
  actionLog(): Promise<readonly LegacyActionLogRow[]>;
  /**
   * Parsed `irsa_config.json` for this scope; 'invalid' when the file cannot be parsed.
   * `inherited` is true when the scope has no file of its own and app.py would copy the
   * default scope's file on first use (app.py `scoped_config`), so that file is returned.
   */
  irsaConfig(): Promise<{
    readonly config: Record<string, unknown> | null | 'invalid';
    readonly inherited: boolean;
  }>;
  /** Bytes of an uploaded file, or null when it is gone, unsafe or not a regular file. */
  readObject(storedName: string): Promise<Uint8Array | null>;
  close(): Promise<void>;
};

export type LegacySource = {
  scopes(): Promise<readonly LegacyScope[]>;
  users(): Promise<readonly LegacyUserRow[]>;
  grants(): Promise<readonly LegacyGrantRow[]>;
  /** Only counted: sessions are deliberately not migrated. */
  sessionCount(): Promise<number>;
  openTenant(scope: LegacyScope): Promise<LegacyTenantReader>;
};

export type TenantBatch = {
  readonly records: readonly TargetRecord[];
  readonly audit: readonly TargetAudit[];
  readonly irsaConfig: Record<string, unknown> | null;
  readonly snapshots: readonly TargetSnapshot[];
  readonly attachments: readonly TargetAttachment[];
  readonly documentReviews: readonly TargetDocumentReview[];
  readonly alerts: readonly TargetAlert[];
  readonly actions: readonly TargetAction[];
  readonly actionLog: readonly TargetActionLog[];
};

export type GlobalBatch = {
  readonly tenants: readonly TargetTenant[];
  readonly users: readonly TargetUser[];
  readonly grants: readonly TargetGrant[];
};

export type GlobalCounts = {
  readonly users: number;
  readonly tenants: number;
  readonly grants: number;
};

export type TargetAttachmentDigest = {
  readonly id: string;
  readonly sha256: string;
  readonly storageKey: string;
};

/** A keyed row whose insert wrote nothing because the key already existed in the target. */
export type SkippedRow = { readonly table: string; readonly id: string };

export type WriteResult<Counts> = {
  readonly counts: Counts;
  readonly skipped: readonly SkippedRow[];
};

/** What verify compares for an account; read only in memory, never reported. */
export type TargetUserState = {
  readonly username: string;
  readonly fullName: string;
  readonly passwordHash: string;
  readonly role: string;
  readonly active: boolean;
  readonly totpEnabled: boolean;
  readonly totpPresent: boolean;
};

export type TargetIdentity = {
  readonly users: readonly TargetUserState[];
  readonly tenants: readonly TargetTenant[];
  readonly grants: readonly TargetGrant[];
};

/** Writes and reads the PostgreSQL side; every tenant write is one transaction. */
export type TargetStore = {
  globalCounts(): Promise<GlobalCounts>;
  tenantCounts(tenantId: string): Promise<TableCounts>;
  writeGlobal(batch: GlobalBatch): Promise<WriteResult<GlobalCounts>>;
  writeTenant(tenantId: string, batch: TenantBatch): Promise<WriteResult<TableCounts>>;
  identity(): Promise<TargetIdentity>;
  /** Canonical row fingerprints (domain `rowFingerprint`) of every tenant table. */
  rowFingerprints(tenantId: string): Promise<Readonly<Record<TenantTable, readonly string[]>>>;
  attachmentDigests(tenantId: string): Promise<readonly TargetAttachmentDigest[]>;
};
