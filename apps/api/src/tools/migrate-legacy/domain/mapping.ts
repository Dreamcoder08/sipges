/**
 * Pure mapping from the legacy SQLite/JSON shapes to the PostgreSQL schema.
 * No I/O, no logging: every rejection travels as a `ProblemCode` so the caller can report
 * counts and identifiers without ever touching record contents (ODD T13 requirement 4).
 */
import { createHash } from 'node:crypto';
import { type Result, err, ok } from '@sipges/kernel';
import type {
  LegacyActionLogRow,
  LegacyActionRow,
  LegacyAlertRow,
  LegacyAttachmentRow,
  LegacyAuditRow,
  LegacyDocumentReviewRow,
  LegacyRecordRow,
  LegacySnapshotRow,
  LegacyUserRow,
  LegacyValue,
} from './legacy.ts';

export type ProblemCode =
  | 'tenant_db_missing'
  | 'tenant_not_in_directory'
  | 'tenant_row_invalid'
  | 'tenant_not_empty'
  | 'tenant_write_failed'
  | 'identity_write_failed'
  | 'row_already_present'
  | 'user_username_invalid'
  | 'user_full_name_invalid'
  | 'user_password_hash_invalid'
  | 'user_role_invalid'
  | 'user_created_at_invalid'
  | 'grant_user_unknown'
  | 'grant_tenant_unknown'
  | 'record_key_invalid'
  | 'record_payload_invalid'
  | 'record_timestamp_invalid'
  | 'audit_row_invalid'
  | 'snapshot_row_invalid'
  | 'attachment_row_invalid'
  | 'attachment_module_unknown'
  | 'attachment_record_missing'
  | 'attachment_object_missing'
  | 'attachment_sha256_mismatch'
  | 'attachment_name_sanitized'
  | 'attachment_stored_name_unsafe'
  | 'document_review_row_invalid'
  | 'alert_row_invalid'
  | 'action_row_invalid'
  | 'action_alert_missing'
  | 'action_log_row_invalid'
  | 'action_log_action_missing'
  | 'irsa_config_invalid'
  | 'irsa_config_inherited'
  | 'sessions_not_migrated'
  | 'target_not_empty'
  | 'verify_count_mismatch'
  | 'verify_checksum_mismatch'
  | 'verify_attachment_missing'
  | 'verify_attachment_mismatch'
  | 'verify_user_missing'
  | 'verify_user_mismatch'
  | 'verify_tenant_missing'
  | 'verify_tenant_mismatch'
  | 'verify_grant_missing'
  | 'verify_row_unexpected';

export const ROLES = ['admin', 'analista', 'coordinador', 'consulta'] as const;
export const REVIEW_STATUSES = [
  'pendiente',
  'aceptado_para_revision',
  'descartado',
  'corroborado_documentalmente',
] as const;
export const ALERT_STATUSES = [
  'Pendiente de verificación',
  'Corroborado',
  'Descartado',
  'En seguimiento',
] as const;
export const ACTION_STATUSES = ['Pendiente', 'En ejecución', 'Completada', 'Cancelada'] as const;

const SHA256 = /^[0-9a-f]{64}$/;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const SAFE_OBJECT_NAME = /^[A-Za-z0-9._-]+$/;

// ---------------------------------------------------------------- coercion

/** SQLite returns text, integers, reals, NULL or blobs; anything else is a bug. */
export const asText = (value: LegacyValue): string | null => {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  if (value instanceof Uint8Array) return Buffer.from(value).toString('utf8');
  return null;
};

export const asNumber = (value: LegacyValue): number | null => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

/** SQLite has no boolean type: app.py stores 0/1 integers. */
export const asBoolean = (value: LegacyValue): boolean => {
  const n = asNumber(value);
  if (n !== null) return n !== 0;
  const text = asText(value);
  return text === 'true' || text === '1';
};

/** Trims and replaces a missing value with `fallback` (legacy columns are often NULL). */
export const textOr = (value: LegacyValue, fallback: string): string => asText(value) ?? fallback;

/**
 * app.py writes `datetime.now().isoformat(timespec='seconds')`: a naive local timestamp.
 * The TypeScript schema stores `timestamptz`, so naive values are read as UTC
 * (documented in docs/migration/data-migration.md).
 */
export const parseLegacyTimestamp = (value: LegacyValue): Date | null => {
  const number = typeof value === 'number' || typeof value === 'bigint' ? Number(value) : null;
  if (number !== null) {
    const fromEpoch = new Date(number * 1000);
    return Number.isNaN(fromEpoch.getTime()) ? null : fromEpoch;
  }
  const text = asText(value)?.trim();
  if (!text) return null;
  const normalized = /(?:Z|[+-]\d{2}:?\d{2})$/.test(text)
    ? text.replace(' ', 'T')
    : `${text.replace(' ', 'T')}Z`;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
};

/** PostgreSQL text and jsonb cannot hold NUL; such a value can never be stored. */
const hasNul = (value: unknown): boolean => {
  if (typeof value === 'string') return value.includes('\u0000');
  if (Array.isArray(value)) return value.some(hasNul);
  if (value !== null && typeof value === 'object')
    return Object.entries(value as Record<string, unknown>).some(
      ([key, item]) => key.includes('\u0000') || hasNul(item),
    );
  return false;
};

export const storableText = (value: string): boolean => !value.includes('\u0000');

/** A parsed JSON value PostgreSQL json/jsonb can hold (no NUL in any key or string). */
export const storableJson = (value: unknown): boolean => !hasNul(value);

/** Every text value a mapper outputs must be storable; `null` (SQL NULL) always is. */
const allStorable = (values: readonly (string | null)[]): boolean =>
  values.every((value) => value === null || storableText(value));

/** Parses a legacy JSON column into a plain object, rejecting anything PostgreSQL refuses. */
export const parseJsonObject = (value: LegacyValue): Record<string, unknown> | null => {
  const text = asText(value);
  if (text === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  return hasNul(parsed) ? null : (parsed as Record<string, unknown>);
};

/** Parses a legacy JSON column app.py reads with `json.loads`; `undefined` when it cannot. */
const parseJsonStrict = (value: LegacyValue): unknown => {
  const text = asText(value);
  if (text === null) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    return hasNul(parsed) ? undefined : parsed;
  } catch {
    return undefined;
  }
};

// ---------------------------------------------------------------- scopes and keys

export const formatTenantId = (companyId: string, projectId: string) => `${companyId}/${projectId}`;

/** app.py:62 — non-default scopes get their own directory, named by this digest. */
export const scopeDigest = (tenantId: string) =>
  createHash('sha256').update(tenantId).digest('hex').slice(0, 24);

export const sha256Hex = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/**
 * app.py:1104 writes `stored_name = f"{uuid4().hex}_{safe_name}"` directly under the scope's
 * upload root. The default scope's root also contains every other tenant's folder, so a name
 * with a path separator, a parent reference or a NUL could read another tenant's file.
 */
export const legacyStoredNameSafe = (storedName: string): boolean =>
  storedName.length > 0 &&
  !/[/\\]/.test(storedName) &&
  storableText(storedName) &&
  !storedName.includes('..') &&
  storedName !== '.';

/**
 * Object key for a migrated attachment: the tenant prefix used by the evidence context plus
 * the legacy `stored_name`. A legacy name the storage adapters refuse is replaced by a
 * deterministic one, so re-running the migration reuses the same key.
 */
export const objectKeyFor = (
  tenantId: string,
  storedName: string,
): { readonly key: string; readonly sanitized: boolean } => {
  const prefix = scopeDigest(tenantId);
  if (SAFE_OBJECT_NAME.test(storedName) && storedName.length <= 180)
    return { key: `${prefix}/${storedName}`, sanitized: false };
  const digest = createHash('sha256').update(storedName).digest('hex').slice(0, 32);
  const tail = storedName
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[-.]+/, '')
    .slice(0, 60);
  return { key: `${prefix}/${digest}_${tail || 'archivo'}`, sanitized: true };
};

// ---------------------------------------------------------------- target rows

export type TargetUser = {
  readonly username: string;
  readonly fullName: string;
  readonly passwordHash: string;
  readonly role: string;
  readonly active: boolean;
  readonly createdAt: Date;
  /** Plaintext legacy TOTP secret; the writer seals it with the configured data key. */
  readonly totpSecret: string | null;
  readonly totpEnabled: boolean;
};

export type TargetGrant = { readonly username: string; readonly tenantId: string };

export type TargetTenant = {
  readonly companyId: string;
  readonly projectId: string;
  readonly label: string;
};

export type TargetRecord = {
  readonly module: string;
  readonly id: string;
  readonly payload: Record<string, unknown>;
  readonly createdAt: Date;
  readonly updatedAt: Date;
};

export type TargetAudit = {
  readonly ts: Date;
  readonly module: string;
  readonly recordId: string | null;
  readonly action: string;
  readonly detail: string | null;
};

export type TargetSnapshot = {
  readonly ts: Date;
  readonly irsa: number;
  readonly level: string;
  readonly scores: unknown;
  readonly configVersion: string | null;
  readonly note: string | null;
};

export type TargetAttachment = {
  readonly id: string;
  readonly storageKey: string;
  readonly legacyStoredName: string;
  readonly originalName: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly sha256: string | null;
  readonly linkedModule: string;
  readonly recordModule: string;
  readonly linkedRecordId: string;
  readonly documentType: string;
  readonly author: string;
  readonly verification: string;
  readonly notes: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly createdAt: Date;
};

export type TargetDocumentReview = {
  readonly id: string;
  readonly projectId: string;
  readonly sourceFile: string;
  readonly sourceSha256: string;
  readonly location: string;
  readonly theme: string;
  readonly excerpt: string;
  readonly action: string;
  readonly status: string;
  readonly reviewer: string;
  readonly note: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
};

export type TargetAlert = {
  readonly id: string;
  readonly projectId: string;
  readonly createdAt: Date;
  readonly sourceUrl: string;
  readonly sourceType: string;
  readonly excerpt: string;
  readonly sha256: string;
  readonly level: string;
  readonly score: number;
  readonly method: string;
  readonly themes: unknown;
  readonly signals: unknown;
  readonly suggestions: unknown;
  readonly semanticActive: boolean;
  readonly status: string;
  readonly analystNote: string;
  readonly reviewerNote: string | null;
  readonly reviewedAt: Date | null;
};

export type TargetAction = {
  readonly id: string;
  readonly projectId: string;
  readonly alertId: string;
  readonly title: string;
  readonly responsible: string;
  readonly dueDate: string;
  readonly description: string;
  readonly status: string;
  readonly progress: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
};

export type TargetActionLog = {
  readonly id: string;
  readonly actionId: string;
  readonly createdAt: Date;
  readonly status: string;
  readonly progress: number;
  readonly note: string;
  readonly evidenceUrl: string | null;
};

// ---------------------------------------------------------------- mappers

const oneOf = <T extends string>(options: readonly T[], value: string): value is T =>
  (options as readonly string[]).includes(value);

/** Tenant directory entry (`tenant_projects`): ids and label must be storable. */
export const mapTenant = (scope: {
  readonly companyId: string;
  readonly projectId: string;
  readonly label: string;
}): Result<TargetTenant, ProblemCode> =>
  scope.companyId && scope.projectId && allStorable([scope.companyId, scope.projectId, scope.label])
    ? ok({ companyId: scope.companyId, projectId: scope.projectId, label: scope.label })
    : err('tenant_row_invalid');

export const mapUser = (row: LegacyUserRow): Result<TargetUser, ProblemCode> => {
  const username = asText(row['username'])?.trim() ?? '';
  if (!username || username.length > 120 || !storableText(username))
    return err('user_username_invalid');
  const fullName = asText(row['full_name']);
  if (fullName === null || !storableText(fullName)) return err('user_full_name_invalid');
  const passwordHash = asText(row['password_hash']) ?? '';
  // Legacy hashes stay as PBKDF2; the identity context verifies and rehashes them on login.
  if (!/^pbkdf2_sha256\$\d{1,7}\$[0-9a-f]+\$[0-9a-f]+$/.test(passwordHash))
    return err('user_password_hash_invalid');
  const role = asText(row['role']) ?? '';
  if (!oneOf(ROLES, role)) return err('user_role_invalid');
  const createdAt = parseLegacyTimestamp(row['created_at']);
  if (!createdAt) return err('user_created_at_invalid');
  const secret = asText(row['totp_secret']);
  return ok({
    username,
    fullName,
    passwordHash,
    role,
    active: asBoolean(row['active'] ?? 1),
    createdAt,
    totpSecret: secret && secret.length > 0 ? secret : null,
    totpEnabled: asBoolean(row['totp_enabled'] ?? 0),
  });
};

export const mapRecord = (row: LegacyRecordRow): Result<TargetRecord, ProblemCode> => {
  const module = asText(row['module']) ?? '';
  const id = asText(row['record_id']) ?? '';
  if (!module || !id || id.length > 200 || !storableText(module) || !storableText(id))
    return err('record_key_invalid');
  const payload = parseJsonObject(row['payload']);
  if (!payload) return err('record_payload_invalid');
  const createdAt = parseLegacyTimestamp(row['created_at']);
  const updatedAt = parseLegacyTimestamp(row['updated_at']);
  if (!createdAt || !updatedAt) return err('record_timestamp_invalid');
  return ok({ module, id, payload, createdAt, updatedAt });
};

export const mapAudit = (row: LegacyAuditRow): Result<TargetAudit, ProblemCode> => {
  const ts = parseLegacyTimestamp(row['ts']);
  const module = asText(row['module']);
  const action = asText(row['action']);
  if (!ts || module === null || action === null) return err('audit_row_invalid');
  const recordId = asText(row['record_id']);
  const detail = asText(row['detail']);
  if (![module, action, recordId ?? '', detail ?? ''].every(storableText))
    return err('audit_row_invalid');
  return ok({ ts, module, recordId, action, detail });
};

export const mapSnapshot = (row: LegacySnapshotRow): Result<TargetSnapshot, ProblemCode> => {
  const ts = parseLegacyTimestamp(row['ts']);
  const irsa = asNumber(row['irsa']);
  const level = asText(row['level']);
  const scores = parseJsonObject(row['scores']);
  const configVersion = asText(row['config_version']);
  const note = asText(row['note']);
  if (!ts || irsa === null || level === null || !scores) return err('snapshot_row_invalid');
  if (!allStorable([level, configVersion, note])) return err('snapshot_row_invalid');
  return ok({ ts, irsa, level, scores, configVersion, note });
};

/**
 * Attachments carry the record module twice in the new schema: the legacy slug (`eventos`)
 * stays in `linked_module`, and `record_module` holds the stored module name for the
 * foreign key to module_records.
 */
export const mapAttachment = (
  row: LegacyAttachmentRow,
  deps: {
    readonly tenantId: string;
    readonly moduleForSlug: (slug: string) => string | null;
  },
): Result<TargetAttachment, ProblemCode> => {
  const id = asText(row['id']) ?? '';
  const storedName = asText(row['stored_name']) ?? '';
  const linkedRecordId = asText(row['linked_record_id']) ?? '';
  const sizeBytes = asNumber(row['size_bytes']) ?? 0;
  const createdAt = parseLegacyTimestamp(row['created_at']);
  if (!id || !storedName || !linkedRecordId || !createdAt || !storableText(id))
    return err('attachment_row_invalid');
  if (!Number.isInteger(sizeBytes) || sizeBytes <= 0) return err('attachment_row_invalid');
  if (!legacyStoredNameSafe(storedName)) return err('attachment_stored_name_unsafe');
  const linkedModule = (asText(row['linked_module']) ?? '').trim().toLowerCase();
  const recordModule = deps.moduleForSlug(linkedModule);
  if (!recordModule) return err('attachment_module_unknown');
  const sha256 = asText(row['sha256']);
  const projectId = textOr(row['project_id'], 'PRJ-SECHURA');
  const attachment = {
    id,
    storageKey: objectKeyFor(deps.tenantId, storedName).key,
    legacyStoredName: storedName,
    originalName: textOr(row['original_name'], storedName),
    contentType: textOr(row['content_type'], 'application/octet-stream'),
    sizeBytes,
    sha256: sha256 && SHA256.test(sha256) ? sha256 : null,
    linkedModule,
    recordModule,
    linkedRecordId,
    documentType: textOr(row['document_type'], ''),
    author: textOr(row['author'], ''),
    verification: textOr(row['verification'], ''),
    notes: textOr(row['notes'], ''),
    projectId,
    projectName: textOr(row['project_name'], projectId === 'PRJ-SECHURA' ? 'Proyecto Sechura' : ''),
    createdAt,
  };
  const texts = [
    attachment.linkedModule,
    attachment.linkedRecordId,
    attachment.originalName,
    attachment.contentType,
    attachment.documentType,
    attachment.author,
    attachment.verification,
    attachment.notes,
    attachment.projectId,
    attachment.projectName,
  ];
  return allStorable(texts) ? ok(attachment) : err('attachment_row_invalid');
};

export const mapDocumentReview = (
  row: LegacyDocumentReviewRow,
): Result<TargetDocumentReview, ProblemCode> => {
  const id = asText(row['id']) ?? '';
  const status = asText(row['status']) ?? '';
  const sourceSha256 = asText(row['source_sha256']) ?? '';
  const createdAt = parseLegacyTimestamp(row['created_at']);
  const updatedAt = parseLegacyTimestamp(row['updated_at']);
  if (
    !id ||
    !createdAt ||
    !updatedAt ||
    !SHA256.test(sourceSha256) ||
    !oneOf(REVIEW_STATUSES, status)
  )
    return err('document_review_row_invalid');
  const review = {
    id,
    projectId: textOr(row['project_id'], 'PRJ-SECHURA'),
    sourceFile: textOr(row['source_file'], ''),
    sourceSha256,
    location: textOr(row['location'], ''),
    theme: textOr(row['theme'], ''),
    excerpt: textOr(row['excerpt'], ''),
    action: textOr(row['action'], ''),
    status,
    reviewer: textOr(row['reviewer'], ''),
    note: textOr(row['note'], ''),
    createdAt,
    updatedAt,
  };
  const texts = [
    review.id,
    review.projectId,
    review.sourceFile,
    review.location,
    review.theme,
    review.excerpt,
    review.action,
    review.reviewer,
    review.note,
  ];
  return texts.every(storableText) ? ok(review) : err('document_review_row_invalid');
};

export const mapAlert = (row: LegacyAlertRow): Result<TargetAlert, ProblemCode> => {
  const id = asText(row['id']) ?? '';
  const createdAt = parseLegacyTimestamp(row['created_at']);
  const status = asText(row['status']) ?? '';
  const sha256 = asText(row['sha256']) ?? '';
  const score = asNumber(row['score']) ?? 0;
  if (!id || !createdAt || !SHA256.test(sha256) || !oneOf(ALERT_STATUSES, status))
    return err('alert_row_invalid');
  // app.py:2093 reads these columns with json.loads: a value it cannot parse is reported, never
  // silently replaced by an empty list.
  const themes = parseJsonStrict(row['themes_json']);
  const signals = parseJsonStrict(row['signals_json']);
  const suggestions = parseJsonStrict(row['suggestions_json']);
  if (themes === undefined || signals === undefined || suggestions === undefined)
    return err('alert_row_invalid');
  const reviewedText = asText(row['reviewed_at'])?.trim() ?? '';
  const reviewedAt = reviewedText ? parseLegacyTimestamp(reviewedText) : null;
  if (reviewedText && !reviewedAt) return err('alert_row_invalid');
  const alert = {
    id,
    projectId: textOr(row['project_id'], 'PRJ-SECHURA'),
    createdAt,
    sourceUrl: textOr(row['source_url'], ''),
    sourceType: textOr(row['source_type'], ''),
    excerpt: textOr(row['excerpt'], ''),
    sha256,
    level: textOr(row['level'], ''),
    score: Math.trunc(score),
    method: textOr(row['method'], ''),
    themes,
    signals,
    suggestions,
    semanticActive: asBoolean(row['semantic_active'] ?? 0),
    status,
    analystNote: textOr(row['analyst_note'], ''),
    reviewerNote: asText(row['reviewer_note']),
    reviewedAt,
  };
  const texts = [
    alert.id,
    alert.projectId,
    alert.sourceUrl,
    alert.sourceType,
    alert.excerpt,
    alert.level,
    alert.method,
    alert.analystNote,
    alert.reviewerNote,
  ];
  return allStorable(texts) ? ok(alert) : err('alert_row_invalid');
};

export const mapAction = (row: LegacyActionRow): Result<TargetAction, ProblemCode> => {
  const id = asText(row['id']) ?? '';
  const alertId = asText(row['alert_id']) ?? '';
  const dueDate = asText(row['due_date']) ?? '';
  const status = asText(row['status']) ?? '';
  const progress = asNumber(row['progress']) ?? 0;
  const createdAt = parseLegacyTimestamp(row['created_at']);
  const updatedAt = parseLegacyTimestamp(row['updated_at']);
  if (!id || !alertId || !createdAt || !updatedAt) return err('action_row_invalid');
  if (!DATE_ONLY.test(dueDate) || !oneOf(ACTION_STATUSES, status)) return err('action_row_invalid');
  if (!Number.isInteger(progress) || progress < 0 || progress > 100)
    return err('action_row_invalid');
  const action = {
    id,
    projectId: textOr(row['project_id'], 'PRJ-SECHURA'),
    alertId,
    title: textOr(row['title'], ''),
    responsible: textOr(row['responsible'], ''),
    dueDate,
    description: textOr(row['description'], ''),
    status,
    progress,
    createdAt,
    updatedAt,
  };
  const texts = [
    action.id,
    action.projectId,
    action.alertId,
    action.title,
    action.responsible,
    action.description,
  ];
  return allStorable(texts) ? ok(action) : err('action_row_invalid');
};

export const mapActionLog = (row: LegacyActionLogRow): Result<TargetActionLog, ProblemCode> => {
  const id = asText(row['id']) ?? '';
  const actionId = asText(row['action_id']) ?? '';
  const createdAt = parseLegacyTimestamp(row['created_at']);
  const progress = asNumber(row['progress']) ?? 0;
  const status = asText(row['status']) ?? '';
  if (!id || !actionId || !createdAt || !status) return err('action_log_row_invalid');
  if (!Number.isInteger(progress) || progress < 0 || progress > 100)
    return err('action_log_row_invalid');
  const note = textOr(row['note'], '');
  const evidenceUrl = asText(row['evidence_url']);
  if (!allStorable([id, actionId, status, note, evidenceUrl])) return err('action_log_row_invalid');
  return ok({ id, actionId, createdAt, status, progress, note, evidenceUrl });
};

// ---------------------------------------------------------------- checksums

/** Stable JSON: object keys sorted, so SQLite text and PostgreSQL jsonb hash alike. */
export const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
};

/** Order-independent digest of a set of rows: each row hashed, digests sorted, then hashed. */
export const setChecksum = (rows: readonly string[]): string => {
  const digests = rows.map((row) => createHash('sha256').update(row).digest('hex')).sort();
  return createHash('sha256').update(digests.join('')).digest('hex');
};

export const recordFingerprint = (module: string, id: string, payload: unknown): string =>
  `${module}\u0001${id}\u0001${canonicalJson(payload)}`;

const iso = (date: Date | null): string | null => (date === null ? null : date.toISOString());

/**
 * Canonical row fingerprints compared by `--verify`, one per tenant table. They cover every
 * migrated column except generated surrogate ids (`audit.id`, `irsa_snapshots.id`) and the
 * legacy-only `stored_name`; the writer reads target rows back into the same shapes.
 */
export const rowFingerprint = {
  module_records: (r: TargetRecord) =>
    canonicalJson([
      recordFingerprint(r.module, r.id, r.payload),
      iso(r.createdAt),
      iso(r.updatedAt),
    ]),
  audit: (a: TargetAudit) => canonicalJson([iso(a.ts), a.module, a.recordId, a.action, a.detail]),
  irsa_configs: (config: Record<string, unknown>) => canonicalJson(config),
  irsa_snapshots: (s: TargetSnapshot) =>
    canonicalJson([iso(s.ts), s.irsa, s.level, s.scores, s.configVersion, s.note]),
  attachments: (a: Omit<TargetAttachment, 'legacyStoredName'>) =>
    canonicalJson([
      a.id,
      a.storageKey,
      a.originalName,
      a.contentType,
      a.sizeBytes,
      a.sha256,
      a.linkedModule,
      a.recordModule,
      a.linkedRecordId,
      a.documentType,
      a.author,
      a.verification,
      a.notes,
      a.projectId,
      a.projectName,
      iso(a.createdAt),
    ]),
  document_review: (r: TargetDocumentReview) =>
    canonicalJson([
      r.id,
      r.projectId,
      r.sourceFile,
      r.sourceSha256,
      r.location,
      r.theme,
      r.excerpt,
      r.action,
      r.status,
      r.reviewer,
      r.note,
      iso(r.createdAt),
      iso(r.updatedAt),
    ]),
  digital_alert_reviews: (a: TargetAlert) =>
    canonicalJson([
      a.id,
      a.projectId,
      iso(a.createdAt),
      a.sourceUrl,
      a.sourceType,
      a.excerpt,
      a.sha256,
      a.level,
      a.score,
      a.method,
      a.themes,
      a.signals,
      a.suggestions,
      a.semanticActive,
      a.status,
      a.analystNote,
      a.reviewerNote,
      iso(a.reviewedAt),
    ]),
  preventive_actions: (a: TargetAction) =>
    canonicalJson([
      a.id,
      a.projectId,
      a.alertId,
      a.title,
      a.responsible,
      a.dueDate,
      a.description,
      a.status,
      a.progress,
      iso(a.createdAt),
      iso(a.updatedAt),
    ]),
  preventive_action_log: (l: TargetActionLog) =>
    canonicalJson([
      l.id,
      l.actionId,
      iso(l.createdAt),
      l.status,
      l.progress,
      l.note,
      l.evidenceUrl,
    ]),
} as const;
