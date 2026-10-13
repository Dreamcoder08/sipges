/**
 * Legacy migration use case (ODD T13). Reads a legacy MASCLI installation through the
 * `LegacySource` port, maps it with the pure functions in ../domain and writes it through
 * the `TargetStore` and `ObjectStorage` ports.
 *
 * Modes:
 * - `dry-run`: reads everything, writes nothing, reports counts and problems;
 * - `apply`: one transaction per tenant, refuses a non-empty target unless told otherwise;
 * - `verify`: compares source and target counts, record checksums and attachment bytes.
 *
 * The report contains counts and identifiers only: never record contents, password hashes
 * or TOTP secrets.
 */
import {
  TENANT_TABLES,
  type TableCounts,
  type TenantTable,
  emptyCounts,
  totalRows,
} from '../domain/legacy.ts';
import {
  type ProblemCode,
  type TargetAttachment,
  type TargetGrant,
  type TargetTenant,
  canonicalJson,
  formatTenantId,
  mapAction,
  mapActionLog,
  mapAlert,
  mapAttachment,
  mapAudit,
  mapDocumentReview,
  mapRecord,
  mapSnapshot,
  mapUser,
  objectKeyFor,
  recordFingerprint,
  setChecksum,
  sha256Hex,
} from '../domain/mapping.ts';
import type {
  GlobalBatch,
  LegacySource,
  ObjectStorage,
  TargetStore,
  TenantBatch,
} from './ports.ts';

export type MigrationMode = 'dry-run' | 'apply' | 'verify';

export type Severity = 'info' | 'warning' | 'error';

/** Diagnostics carry codes and identifiers only, never values from the legacy data. */
export type Problem = {
  readonly code: ProblemCode;
  readonly severity: Severity;
  readonly tenantId?: string;
  readonly table?: string;
  readonly id?: string;
  readonly count?: number;
};

export type ObjectReport = {
  readonly expected: number;
  readonly copied: number;
  readonly verified: number;
  readonly missing: number;
  readonly mismatched: number;
};

export type TenantReport = {
  readonly tenantId: string;
  readonly label: string;
  readonly sourcePresent: boolean;
  readonly source: TableCounts;
  readonly mapped: TableCounts;
  readonly written: TableCounts;
  readonly target: TableCounts;
  readonly objects: ObjectReport;
  readonly checksums: {
    readonly sourceRecords: string;
    readonly targetRecords: string | null;
  };
  readonly problems: readonly Problem[];
};

export type CountPair = {
  readonly source: number;
  readonly mapped: number;
  readonly written: number;
};

export type MigrationReport = {
  readonly mode: MigrationMode;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly applied: boolean;
  readonly identity: {
    readonly users: CountPair;
    readonly tenants: CountPair;
    readonly grants: CountPair;
    readonly sessionsSkipped: number;
  };
  readonly tenants: readonly TenantReport[];
  /** Problems outside a single tenant; per-tenant problems live in `tenants[].problems`. */
  readonly problems: readonly Problem[];
  /** False when any problem has severity `error`; the CLI exits non-zero. */
  readonly ok: boolean;
};

export type MigrationOptions = {
  readonly mode: MigrationMode;
  /** Writes into a target that already holds data (re-runs are otherwise refused). */
  readonly allowNonEmptyTarget?: boolean;
  /** Restricts the run to these `company/project` ids. */
  readonly only?: readonly string[];
};

export type MigrationDeps = {
  readonly source: LegacySource;
  readonly target: TargetStore;
  readonly storage: ObjectStorage;
  /** Legacy module slug → stored module name (records context public API). */
  readonly moduleForSlug: (slug: string) => string | null;
  readonly now: () => Date;
};

const SEVERITY: Partial<Record<ProblemCode, Severity>> = {
  attachment_name_sanitized: 'warning',
  sessions_not_migrated: 'info',
  tenant_db_missing: 'warning',
};

const problem = (code: ProblemCode, extra: Omit<Problem, 'code' | 'severity'> = {}): Problem => ({
  code,
  severity: SEVERITY[code] ?? 'error',
  ...extra,
});

type MapResult<T> = { ok: true; value: T } | { ok: false; error: ProblemCode };

/** Applies a mapper to every row, reporting rejections instead of throwing. */
const collect = <Row, Value>(
  rows: readonly Row[],
  map: (row: Row) => MapResult<Value>,
  onError: (code: ProblemCode, index: number) => void,
): Value[] => {
  const out: Value[] = [];
  rows.forEach((row, index) => {
    const result = map(row);
    if (result.ok) out.push(result.value);
    else onError(result.error, index);
  });
  return out;
};

type Prepared = {
  readonly tenantId: string;
  readonly label: string;
  readonly present: boolean;
  readonly source: Record<TenantTable, number>;
  readonly mapped: Record<TenantTable, number>;
  readonly objects: {
    expected: number;
    copied: number;
    verified: number;
    missing: number;
    mismatched: number;
  };
  readonly problems: Problem[];
  readonly batch: TenantBatch;
  /** Attachment bytes held for the apply phase; never part of a report. */
  readonly bytes: Map<string, Uint8Array>;
  readonly sourceChecksum: string;
};

const prepareTenant = async (
  deps: MigrationDeps,
  scope: { companyId: string; projectId: string; label: string },
): Promise<Prepared> => {
  const tenantId = formatTenantId(scope.companyId, scope.projectId);
  const reader = await deps.source.openTenant(scope);
  const problems: Problem[] = [];
  const source = emptyCounts() as Record<TenantTable, number>;
  const mapped = emptyCounts() as Record<TenantTable, number>;
  const objects = { expected: 0, copied: 0, verified: 0, missing: 0, mismatched: 0 };
  const bytes = new Map<string, Uint8Array>();
  const note =
    (table: TenantTable, idOf: (index: number) => string) =>
    (code: ProblemCode, index: number): void => {
      problems.push(problem(code, { tenantId, table, id: idOf(index) }));
    };
  const idAt = (rows: readonly Record<string, unknown>[], key: string) => (index: number) =>
    String(rows[index]?.[key] ?? `#${index}`);

  try {
    if (!reader.present) problems.push(problem('tenant_db_missing', { tenantId }));

    const recordRows = await reader.records();
    source.module_records = recordRows.length;
    const records = collect(
      recordRows,
      mapRecord,
      note('module_records', idAt(recordRows, 'record_id')),
    );
    mapped.module_records = records.length;
    const recordKeys = new Set(records.map((r) => `${r.module}\u0001${r.id}`));

    const auditRows = await reader.audit();
    source.audit = auditRows.length;
    const audit = collect(auditRows, mapAudit, note('audit', idAt(auditRows, 'id')));
    mapped.audit = audit.length;

    const snapshotRows = await reader.snapshots();
    source.irsa_snapshots = snapshotRows.length;
    const snapshots = collect(
      snapshotRows,
      mapSnapshot,
      note('irsa_snapshots', idAt(snapshotRows, 'id')),
    );
    mapped.irsa_snapshots = snapshots.length;

    const config = await reader.irsaConfig();
    source.irsa_configs = config === null ? 0 : 1;
    if (config === 'invalid')
      problems.push(problem('irsa_config_invalid', { tenantId, table: 'irsa_configs' }));
    const irsaConfig = config === 'invalid' ? null : config;
    mapped.irsa_configs = irsaConfig ? 1 : 0;

    const attachmentRows = await reader.attachments();
    source.attachments = attachmentRows.length;
    const candidates = collect(
      attachmentRows,
      (row) => mapAttachment(row, { tenantId, moduleForSlug: deps.moduleForSlug }),
      note('attachments', idAt(attachmentRows, 'id')),
    );
    const attachments: TargetAttachment[] = [];
    for (const attachment of candidates) {
      const at = { tenantId, table: 'attachments', id: attachment.id };
      if (!recordKeys.has(`${attachment.recordModule}\u0001${attachment.linkedRecordId}`)) {
        problems.push(problem('attachment_record_missing', at));
        continue;
      }
      if (objectKeyFor(tenantId, attachment.legacyStoredName).sanitized)
        problems.push(problem('attachment_name_sanitized', at));
      objects.expected += 1;
      const data = await reader.readObject(attachment.legacyStoredName);
      if (!data) {
        problems.push(problem('attachment_object_missing', at));
        objects.missing += 1;
        continue;
      }
      const digest = sha256Hex(data);
      if (attachment.sha256 !== null && attachment.sha256 !== digest) {
        problems.push(problem('attachment_sha256_mismatch', at));
        objects.mismatched += 1;
        continue;
      }
      bytes.set(attachment.id, data);
      attachments.push({ ...attachment, sha256: digest, sizeBytes: data.length });
    }
    mapped.attachments = attachments.length;

    const reviewRows = await reader.documentReviews();
    source.document_review = reviewRows.length;
    const documentReviews = collect(
      reviewRows,
      mapDocumentReview,
      note('document_review', idAt(reviewRows, 'id')),
    );
    mapped.document_review = documentReviews.length;

    const alertRows = await reader.alerts();
    source.digital_alert_reviews = alertRows.length;
    const alerts = collect(
      alertRows,
      mapAlert,
      note('digital_alert_reviews', idAt(alertRows, 'id')),
    );
    mapped.digital_alert_reviews = alerts.length;
    const alertIds = new Set(alerts.map((a) => a.id));

    const actionRows = await reader.actions();
    source.preventive_actions = actionRows.length;
    const actions = collect(
      actionRows,
      mapAction,
      note('preventive_actions', idAt(actionRows, 'id')),
    ).filter((action) => {
      if (alertIds.has(action.alertId)) return true;
      problems.push(
        problem('action_alert_missing', { tenantId, table: 'preventive_actions', id: action.id }),
      );
      return false;
    });
    mapped.preventive_actions = actions.length;
    const actionIds = new Set(actions.map((a) => a.id));

    const logRows = await reader.actionLog();
    source.preventive_action_log = logRows.length;
    const actionLog = collect(
      logRows,
      mapActionLog,
      note('preventive_action_log', idAt(logRows, 'id')),
    ).filter((entry) => {
      if (actionIds.has(entry.actionId)) return true;
      problems.push(
        problem('action_log_action_missing', {
          tenantId,
          table: 'preventive_action_log',
          id: entry.id,
        }),
      );
      return false;
    });
    mapped.preventive_action_log = actionLog.length;

    return {
      tenantId,
      label: scope.label,
      present: reader.present,
      source,
      mapped,
      objects,
      problems,
      bytes,
      sourceChecksum: setChecksum(records.map((r) => recordFingerprint(r.module, r.id, r.payload))),
      batch: {
        records,
        audit,
        irsaConfig,
        snapshots,
        attachments,
        documentReviews,
        alerts,
        actions,
        actionLog,
      },
    };
  } finally {
    await reader.close();
  }
};

export const runMigration = async (
  deps: MigrationDeps,
  options: MigrationOptions,
): Promise<MigrationReport> => {
  const startedAt = deps.now().toISOString();
  const globalProblems: Problem[] = [];

  const scopes = await deps.source.scopes();
  const wanted = options.only ?? [];
  const selected = wanted.length
    ? scopes.filter((s) => wanted.includes(formatTenantId(s.companyId, s.projectId)))
    : scopes;
  for (const id of wanted) {
    if (!scopes.some((s) => formatTenantId(s.companyId, s.projectId) === id))
      globalProblems.push(problem('tenant_not_in_directory', { tenantId: id }));
  }

  // ---- identity -----------------------------------------------------------
  const userRows = await deps.source.users();
  const users = collect(userRows, mapUser, (code, index) => {
    globalProblems.push(
      problem(code, { table: 'users', id: String(userRows[index]?.['username'] ?? `#${index}`) }),
    );
  });
  const usernames = new Set(users.map((u) => u.username));
  const tenants: TargetTenant[] = selected.map((scope) => ({
    companyId: scope.companyId,
    projectId: scope.projectId,
    label: scope.label,
  }));
  const tenantIds = new Set(tenants.map((t) => formatTenantId(t.companyId, t.projectId)));
  const grantRows = await deps.source.grants();
  const grants: TargetGrant[] = [];
  for (const row of grantRows) {
    const tenantId = formatTenantId(row.scope.companyId, row.scope.projectId);
    const at = { table: 'grants', id: row.username, tenantId };
    if (!usernames.has(row.username)) globalProblems.push(problem('grant_user_unknown', at));
    else if (!tenantIds.has(tenantId)) globalProblems.push(problem('grant_tenant_unknown', at));
    else grants.push({ username: row.username, tenantId });
  }

  const sessionsSkipped = await deps.source.sessionCount();
  if (sessionsSkipped > 0)
    globalProblems.push(problem('sessions_not_migrated', { count: sessionsSkipped }));

  // ---- per-tenant mapping -------------------------------------------------
  const prepared: Prepared[] = [];
  for (const scope of selected) prepared.push(await prepareTenant(deps, scope));

  // ---- emptiness guard ----------------------------------------------------
  const before = await deps.target.globalCounts();
  const existing = new Map<string, TableCounts>();
  for (const entry of prepared)
    existing.set(entry.tenantId, await deps.target.tenantCounts(entry.tenantId));
  const occupied = [...existing.entries()].filter(([, counts]) => totalRows(counts) > 0);
  const identityOccupied = before.users > 0 || before.grants > 0;
  const refuse =
    options.mode === 'apply' &&
    options.allowNonEmptyTarget !== true &&
    (occupied.length > 0 || identityOccupied);
  if (refuse) {
    for (const [tenantId, counts] of occupied)
      globalProblems.push(
        problem('target_not_empty', { tenantId, table: 'tenant', count: totalRows(counts) }),
      );
    if (identityOccupied)
      globalProblems.push(problem('target_not_empty', { table: 'users', count: before.users }));
  }

  // ---- write --------------------------------------------------------------
  const identity = {
    users: { source: userRows.length, mapped: users.length, written: 0 },
    tenants: { source: scopes.length, mapped: tenants.length, written: 0 },
    grants: { source: grantRows.length, mapped: grants.length, written: 0 },
    sessionsSkipped,
  };
  const applied = options.mode === 'apply' && !refuse;
  const written = new Map<string, TableCounts>();

  if (applied) {
    const batch: GlobalBatch = { tenants, users, grants };
    const counts = await deps.target.writeGlobal(batch);
    identity.users.written = counts.users;
    identity.tenants.written = counts.tenants;
    identity.grants.written = counts.grants;
    for (const entry of prepared) {
      for (const attachment of entry.batch.attachments) {
        const data = entry.bytes.get(attachment.id);
        if (!data) continue;
        // Objects are written before the metadata transaction. Keys are deterministic, so a
        // retried run reuses the same key instead of leaving a second copy behind.
        await deps.storage.put(attachment.storageKey, data, attachment.contentType);
        entry.objects.copied += 1;
      }
      written.set(entry.tenantId, await deps.target.writeTenant(entry.tenantId, entry.batch));
    }
  }

  // ---- read back and verify ----------------------------------------------
  const tenantReports: TenantReport[] = [];
  for (const entry of prepared) {
    const target = await deps.target.tenantCounts(entry.tenantId);
    let targetChecksum: string | null = null;
    if (options.mode === 'verify') {
      targetChecksum = setChecksum(await deps.target.recordFingerprints(entry.tenantId));
      if (targetChecksum !== entry.sourceChecksum)
        entry.problems.push(
          problem('verify_checksum_mismatch', {
            tenantId: entry.tenantId,
            table: 'module_records',
          }),
        );
      for (const table of TENANT_TABLES) {
        if (entry.mapped[table] !== target[table])
          entry.problems.push(
            problem('verify_count_mismatch', {
              tenantId: entry.tenantId,
              table,
              count: target[table],
            }),
          );
      }
      for (const digest of await deps.target.attachmentDigests(entry.tenantId)) {
        const at = { tenantId: entry.tenantId, table: 'attachments', id: digest.id };
        const stored = await deps.storage.get(digest.storageKey);
        if (!stored) entry.problems.push(problem('verify_attachment_missing', at));
        else if (sha256Hex(stored) !== digest.sha256)
          entry.problems.push(problem('verify_attachment_mismatch', at));
        else entry.objects.verified += 1;
      }
    }
    tenantReports.push({
      tenantId: entry.tenantId,
      label: entry.label,
      sourcePresent: entry.present,
      source: entry.source,
      mapped: entry.mapped,
      written: written.get(entry.tenantId) ?? emptyCounts(),
      target,
      objects: entry.objects,
      checksums: { sourceRecords: entry.sourceChecksum, targetRecords: targetChecksum },
      problems: entry.problems,
    });
  }

  const everyProblem = [...globalProblems, ...tenantReports.flatMap((t) => t.problems)];
  return {
    mode: options.mode,
    startedAt,
    finishedAt: deps.now().toISOString(),
    applied,
    identity,
    tenants: tenantReports,
    problems: globalProblems,
    ok: !everyProblem.some((p) => p.severity === 'error'),
  };
};

/** Operator summary: counts only, never contents. */
export const summarize = (report: MigrationReport): string => {
  const errors = [...report.problems, ...report.tenants.flatMap((t) => t.problems)].filter(
    (p) => p.severity === 'error',
  );
  const codes = new Map<string, number>();
  for (const p of errors) codes.set(p.code, (codes.get(p.code) ?? 0) + 1);
  return [
    `mode=${report.mode} applied=${report.applied} ok=${report.ok} errors=${errors.length}`,
    `users ${report.identity.users.mapped}/${report.identity.users.source}` +
      `, tenants ${report.identity.tenants.mapped}/${report.identity.tenants.source}` +
      `, grants ${report.identity.grants.mapped}/${report.identity.grants.source}` +
      `, sessions skipped ${report.identity.sessionsSkipped}`,
    ...report.tenants.map(
      (t) =>
        `${t.tenantId}: source ${totalRows(t.source)} / mapped ${totalRows(t.mapped)}` +
        ` / written ${totalRows(t.written)} / target ${totalRows(t.target)}` +
        ` / objects ${t.objects.copied}+${t.objects.verified} of ${t.objects.expected}`,
    ),
    ...[...codes].map(([code, count]) => `error ${code} x${count}`),
  ].join('\n');
};

/** JSON report, safe to keep next to the backup: counts, codes and identifiers only. */
export const reportJson = (report: MigrationReport): string => canonicalJson(report);
