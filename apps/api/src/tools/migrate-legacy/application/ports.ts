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
  /** Parsed `irsa_config.json` for this scope; 'invalid' when the file cannot be parsed. */
  irsaConfig(): Promise<Record<string, unknown> | null | 'invalid'>;
  /** Bytes of an uploaded file, or null when it is gone from the legacy upload root. */
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

/** Writes and reads the PostgreSQL side; every tenant write is one transaction. */
export type TargetStore = {
  globalCounts(): Promise<GlobalCounts>;
  tenantCounts(tenantId: string): Promise<TableCounts>;
  writeGlobal(batch: GlobalBatch): Promise<GlobalCounts>;
  writeTenant(tenantId: string, batch: TenantBatch): Promise<TableCounts>;
  /** `module \u0001 id \u0001 canonical payload` for every stored record. */
  recordFingerprints(tenantId: string): Promise<readonly string[]>;
  attachmentDigests(tenantId: string): Promise<readonly TargetAttachmentDigest[]>;
};
