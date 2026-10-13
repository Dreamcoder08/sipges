/**
 * Shapes of the legacy SQLite rows and JSON configuration (app.py, docs/migration/behavior-contract.md §3-4).
 * Values arrive from SQLite untyped, so every field is `unknown` and is coerced by the mapping.
 */

export type LegacyValue = unknown;
export type LegacyRow = Readonly<Record<string, LegacyValue>>;

/** `auth_global.db` tables (app.py:427-447). */
export type LegacyTenantRow = LegacyRow; // tenant_projects(company_id, project_id, label)
export type LegacyUserRow = LegacyRow; // auth_users(username, full_name, password_hash, role, active, created_at, totp_secret, totp_enabled)
export type LegacyGrantRow = LegacyRow; // access_grants(username, company_id, project_id)

/** Per-tenant DB tables (app.py:79-124, :1809, :2057, :2143). */
export type LegacyRecordRow = LegacyRow; // records(module, record_id, payload, created_at, updated_at)
export type LegacyAuditRow = LegacyRow; // audit(id, ts, module, record_id, action, detail)
export type LegacySnapshotRow = LegacyRow; // irsa_snapshots(id, ts, irsa, level, scores, config_version, note)
export type LegacyAttachmentRow = LegacyRow; // attachments(id, stored_name, ...)
export type LegacyDocumentReviewRow = LegacyRow;
export type LegacyAlertRow = LegacyRow; // digital_alert_reviews(..., themes_json, signals_json, suggestions_json)
export type LegacyActionRow = LegacyRow; // preventive_actions
export type LegacyActionLogRow = LegacyRow; // preventive_action_log

/** The tenant directory entry that selects a legacy database file and upload root. */
export type LegacyScope = {
  readonly companyId: string;
  readonly projectId: string;
  readonly label: string;
};

/** Business tables compared and reported per tenant. */
export const TENANT_TABLES = [
  'module_records',
  'audit',
  'irsa_configs',
  'irsa_snapshots',
  'attachments',
  'document_review',
  'digital_alert_reviews',
  'preventive_actions',
  'preventive_action_log',
] as const;

export type TenantTable = (typeof TENANT_TABLES)[number];

export type TableCounts = Readonly<Record<TenantTable, number>>;

export const emptyCounts = (): TableCounts =>
  Object.fromEntries(TENANT_TABLES.map((table) => [table, 0])) as TableCounts;

export const totalRows = (counts: TableCounts): number =>
  TENANT_TABLES.reduce((sum, table) => sum + counts[table], 0);
