import type { Scope } from '../domain/scope.ts';

export type TenantSummary = Scope & { readonly label: string };

export type TenancyStore = {
  /** Inserts the tenant when missing (bootstrap). */
  ensureTenant(scope: Scope, label: string, at: Date): Promise<void>;
  /** Creates the tenant and its first grant atomically; false when the tenant exists. */
  createTenantWithGrant(scope: Scope, label: string, username: string, at: Date): Promise<boolean>;
  tenantExists(scope: Scope): Promise<boolean>;
  /** Idempotent. */
  grant(username: string, scope: Scope, at: Date): Promise<void>;
  /** Deletes exactly one grant; false when it was already absent. */
  revoke(username: string, scope: Scope): Promise<boolean>;
  listGrants(username: string): Promise<TenantSummary[]>;
};

/** What Tenancy needs to know about accounts, provided by Identity's public API. */
export type UserDirectory = {
  exists(username: string): Promise<boolean>;
  adminUsernames(): Promise<string[]>;
};

export type TenantExportData = {
  readonly module_records: Record<string, unknown>[];
  readonly audit: Record<string, unknown>[];
  readonly attachments: Record<string, unknown>[];
  readonly document_review: Record<string, unknown>[];
  readonly digital_alert_reviews: Record<string, unknown>[];
  readonly preventive_actions: Record<string, unknown>[];
  readonly preventive_action_log: Record<string, unknown>[];
  readonly record_versions: Record<string, unknown>[];
  readonly record_links: Record<string, unknown>[];
  readonly automation_rules: Record<string, unknown>[];
  readonly automation_runs: Record<string, unknown>[];
  readonly notifications: Record<string, unknown>[];
  readonly source_import_settings: Record<string, unknown>[];
  readonly project_settings: Record<string, unknown>[];
};

/** Only tenant-owned business data, never a physical database/global directory dump. */
export type TenantDataReader = { read(scope: Scope): Promise<TenantExportData> };

export type Clock = { now(): Date };
