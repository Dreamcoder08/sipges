//! `application/migrate.ts`: the use case. A dry run reads everything and writes nothing; apply
//! writes one transaction per tenant and refuses a non-empty target unless told otherwise; verify
//! compares source and target counts, row checksums, attachment bytes and the identity tables.
//!
//! Reports carry counts and identifiers only. A failed write is a problem code, never a driver
//! message, which could quote the rejected values.

use std::collections::{HashMap, HashSet};
use std::fmt::Write as _;

use crate::json::{self, Json};
use crate::mapping::{
    Attachment, Code, Fatal, Mapped, Reject, Scope, fingerprint_action, fingerprint_action_log,
    fingerprint_alert, fingerprint_attachment, fingerprint_audit, fingerprint_record,
    fingerprint_review, fingerprint_snapshot, format_tenant_id, map_action, map_action_log,
    map_alert, map_attachment, map_audit, map_document_review, map_record, map_snapshot, map_user,
    object_key_for, set_checksum, sha256_hex,
};
use crate::source::{IrsaConfig, Source};
use crate::storage::Storage;
use crate::store::{Counts, GlobalBatch, Grant, Skipped, Store, TENANT_TABLES, TenantBatch, table};
use crate::value::{Row, js_string};

/// `MigrationMode`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    /// Read and report only.
    DryRun,
    /// Write.
    Apply,
    /// Compare source and target.
    Verify,
}

impl Mode {
    /// The name in reports.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::DryRun => "dry-run",
            Self::Apply => "apply",
            Self::Verify => "verify",
        }
    }
}

/// `MigrationOptions`.
#[derive(Clone, Copy, Debug)]
pub struct Options<'a> {
    /// The mode.
    pub mode: Mode,
    /// Writes into a target that already holds data.
    pub allow_non_empty: bool,
    /// Restricts the run to these `company/project` ids.
    pub only: &'a [String],
}

/// `Problem`: codes and identifiers only.
#[derive(Clone, Debug, Default)]
pub struct Problem {
    /// The code.
    pub code: Code,
    /// The tenant.
    pub tenant_id: Option<String>,
    /// The table.
    pub table: Option<String>,
    /// The row's identifier.
    pub id: Option<String>,
    /// A count.
    pub count: Option<usize>,
}

/// `SEVERITY`, defaulting to `error`.
fn severity(code: Code) -> &'static str {
    match code {
        "attachment_name_sanitized" | "tenant_db_missing" | "verify_row_unexpected" => "warning",
        "irsa_config_inherited" | "sessions_not_migrated" => "info",
        _ => "error",
    }
}

impl Problem {
    fn new(code: Code) -> Self {
        Self {
            code,
            ..Self::default()
        }
    }
    fn tenant(mut self, tenant: &str) -> Self {
        self.tenant_id = Some(tenant.to_owned());
        self
    }
    fn table(mut self, table: &str) -> Self {
        self.table = Some(table.to_owned());
        self
    }
    fn id(mut self, id: impl Into<String>) -> Self {
        self.id = Some(id.into());
        self
    }
    const fn count(mut self, count: usize) -> Self {
        self.count = Some(count);
        self
    }
    fn is_error(&self) -> bool {
        severity(self.code) == "error"
    }
    fn to_json(&self) -> Json {
        let mut entries = vec![
            ("code", Json::text(self.code)),
            ("severity", Json::text(severity(self.code))),
        ];
        for (key, value) in [
            ("tenantId", &self.tenant_id),
            ("table", &self.table),
            ("id", &self.id),
        ] {
            if let Some(value) = value {
                entries.push((key, Json::text(value)));
            }
        }
        if let Some(count) = self.count {
            entries.push(("count", number(count)));
        }
        Json::object(entries)
    }
}

#[allow(clippy::cast_precision_loss)]
const fn number(value: usize) -> Json {
    Json::Num(value as f64)
}

/// `ObjectReport`.
#[derive(Clone, Copy, Debug, Default)]
pub struct Objects {
    /// Attachments whose bytes are expected.
    pub expected: usize,
    /// Copied to storage.
    pub copied: usize,
    /// Verified in storage.
    pub verified: usize,
    /// Missing at the source.
    pub missing: usize,
    /// Digest mismatch at the source.
    pub mismatched: usize,
}

/// `Prepared`.
struct Prepared {
    tenant_id: String,
    label: String,
    present: bool,
    source: Counts,
    mapped: Counts,
    objects: Objects,
    problems: Vec<Problem>,
    batch: TenantBatch,
    /// Attachment bytes held for the apply phase; never part of a report.
    bytes: HashMap<String, Vec<u8>>,
    source_checksums: [String; 9],
}

/// `TenantReport`.
#[derive(Clone, Debug)]
pub struct TenantReport {
    tenant_id: String,
    label: String,
    source_present: bool,
    source: Counts,
    mapped: Counts,
    written: Counts,
    target: Counts,
    objects: Objects,
    source_checksums: [String; 9],
    target_checksums: Option<[String; 9]>,
    problems: Vec<Problem>,
}

/// `CountPair`.
#[derive(Clone, Copy, Debug, Default)]
pub struct CountPair {
    source: usize,
    mapped: usize,
    written: usize,
}

/// `MigrationReport`.
#[derive(Clone, Debug)]
pub struct Report {
    mode: Mode,
    started_at: String,
    finished_at: String,
    applied: bool,
    users: CountPair,
    tenants: CountPair,
    grants: CountPair,
    sessions_skipped: usize,
    tenant_reports: Vec<TenantReport>,
    problems: Vec<Problem>,
    /// False when any problem is an error: the CLI exits non-zero.
    pub ok: bool,
}

/// `totalRows`.
fn total(counts: &Counts) -> usize {
    counts.iter().sum()
}

/// `collect`: rejected rows become problems; a fatal failure stops the run.
fn collect<T>(
    rows: &[Row],
    map: impl Fn(&Row) -> Mapped<T>,
    mut on_error: impl FnMut(Code, usize),
) -> Result<Vec<T>, Fatal> {
    let mut out = Vec::with_capacity(rows.len());
    for (index, row) in rows.iter().enumerate() {
        match map(row) {
            Ok(value) => out.push(value),
            Err(Reject::Code(code)) => on_error(code, index),
            Err(Reject::Fatal(fatal)) => return Err(fatal),
        }
    }
    Ok(out)
}

/// `String(row[key] ?? '#index')`.
fn id_at(rows: &[Row], key: &str, index: usize) -> String {
    rows.get(index)
        .and_then(|row| js_string(row.get(key)))
        .unwrap_or_else(|| format!("#{index}"))
}

fn checksums_of(rows: &[Vec<String>; 9]) -> [String; 9] {
    std::array::from_fn(|i| {
        rows.get(i)
            .map_or_else(String::new, |row| set_checksum(row))
    })
}

/// `batchFingerprints`.
fn batch_fingerprints(batch: &TenantBatch) -> [Vec<String>; 9] {
    [
        batch.records.iter().map(fingerprint_record).collect(),
        batch.audit.iter().map(fingerprint_audit).collect(),
        batch.irsa_config.iter().map(json::canonical).collect(),
        batch.snapshots.iter().map(fingerprint_snapshot).collect(),
        batch
            .attachments
            .iter()
            .map(fingerprint_attachment)
            .collect(),
        batch
            .document_reviews
            .iter()
            .map(fingerprint_review)
            .collect(),
        batch.alerts.iter().map(fingerprint_alert).collect(),
        batch.actions.iter().map(fingerprint_action).collect(),
        batch
            .action_log
            .iter()
            .map(fingerprint_action_log)
            .collect(),
    ]
}

fn set(counts: &mut Counts, index: usize, value: usize) {
    if let Some(slot) = counts.get_mut(index) {
        *slot = value;
    }
}

/// Bytes of the attachments that pass, with their digest and real size.
fn read_attachments(
    reader: &crate::source::TenantReader,
    tenant: &str,
    candidates: Vec<Attachment>,
    record_keys: &HashSet<(String, String)>,
    prepared: (
        &mut Objects,
        &mut Vec<Problem>,
        &mut HashMap<String, Vec<u8>>,
    ),
) -> Vec<Attachment> {
    let (objects, problems, bytes) = prepared;
    let mut attachments = Vec::new();
    for mut attachment in candidates {
        let at = |code| {
            Problem::new(code)
                .tenant(tenant)
                .table("attachments")
                .id(attachment.id.clone())
        };
        let key = (
            attachment.record_module.clone(),
            attachment.linked_record_id.clone(),
        );
        if !record_keys.contains(&key) {
            problems.push(at("attachment_record_missing"));
            continue;
        }
        if object_key_for(tenant, &attachment.legacy_stored_name).1 {
            problems.push(at("attachment_name_sanitized"));
        }
        objects.expected += 1;
        let Some(data) = reader.read_object(&attachment.legacy_stored_name) else {
            problems.push(at("attachment_object_missing"));
            objects.missing += 1;
            continue;
        };
        let digest = sha256_hex(&data);
        if attachment.sha256.as_ref().is_some_and(|sha| *sha != digest) {
            problems.push(at("attachment_sha256_mismatch"));
            objects.mismatched += 1;
            continue;
        }
        attachment.sha256 = Some(digest);
        #[allow(clippy::cast_precision_loss)]
        {
            attachment.size_bytes = data.len() as f64;
        }
        bytes.insert(attachment.id.clone(), data);
        attachments.push(attachment);
    }
    attachments
}

/// `prepareTenant`.
#[allow(clippy::too_many_lines)]
fn prepare_tenant(source: &Source, scope: &Scope) -> Result<Prepared, Fatal> {
    let tenant = scope.tenant_id();
    let reader = source.open_tenant(scope)?;
    let mut problems = Vec::new();
    let mut objects = Objects::default();
    let mut bytes = HashMap::new();
    let (mut sources, mut mapped): (Counts, Counts) = ([0; 9], [0; 9]);
    let table_name = |index: usize| TENANT_TABLES.get(index).copied().unwrap_or_default();

    if !reader.present() {
        problems.push(Problem::new("tenant_db_missing").tenant(&tenant));
    }

    macro_rules! read {
        ($rows:ident, $index:expr, $key:literal, $map:expr) => {{
            let list = collect(&$rows, $map, |code, at| {
                problems.push(
                    Problem::new(code)
                        .tenant(&tenant)
                        .table(table_name($index))
                        .id(id_at(&$rows, $key, at)),
                );
            })?;
            list
        }};
    }

    let record_rows = reader.records()?;
    set(&mut sources, table::RECORDS, record_rows.len());
    let records = read!(record_rows, table::RECORDS, "record_id", map_record);
    set(&mut mapped, table::RECORDS, records.len());
    let record_keys: HashSet<(String, String)> = records
        .iter()
        .map(|r| (r.module.clone(), r.id.clone()))
        .collect();

    let audit_rows = reader.audit()?;
    set(&mut sources, table::AUDIT, audit_rows.len());
    let audit = read!(audit_rows, table::AUDIT, "id", map_audit);
    set(&mut mapped, table::AUDIT, audit.len());

    let snapshot_rows = reader.snapshots()?;
    set(&mut sources, table::SNAPSHOTS, snapshot_rows.len());
    let snapshots = read!(snapshot_rows, table::SNAPSHOTS, "id", map_snapshot);
    set(&mut mapped, table::SNAPSHOTS, snapshots.len());

    let (config, inherited) = reader.irsa_config();
    set(
        &mut sources,
        table::IRSA_CONFIGS,
        usize::from(config != IrsaConfig::Absent),
    );
    let irsa_config = match config {
        IrsaConfig::TooDeep => return Err(Fatal::named("RangeError")),
        IrsaConfig::Absent => None,
        IrsaConfig::Object(object) if !json::has_nul(&object) => {
            if inherited {
                problems.push(
                    Problem::new("irsa_config_inherited")
                        .tenant(&tenant)
                        .table("irsa_configs"),
                );
            }
            Some(object)
        }
        IrsaConfig::Invalid | IrsaConfig::Object(_) => {
            problems.push(
                Problem::new("irsa_config_invalid")
                    .tenant(&tenant)
                    .table("irsa_configs"),
            );
            None
        }
    };
    set(
        &mut mapped,
        table::IRSA_CONFIGS,
        usize::from(irsa_config.is_some()),
    );

    let attachment_rows = reader.attachments()?;
    set(&mut sources, table::ATTACHMENTS, attachment_rows.len());
    let candidates = read!(attachment_rows, table::ATTACHMENTS, "id", |row| {
        map_attachment(row, &tenant)
    });
    let attachments = read_attachments(
        &reader,
        &tenant,
        candidates,
        &record_keys,
        (&mut objects, &mut problems, &mut bytes),
    );
    set(&mut mapped, table::ATTACHMENTS, attachments.len());

    let review_rows = reader.document_reviews()?;
    set(&mut sources, table::REVIEWS, review_rows.len());
    let document_reviews = read!(review_rows, table::REVIEWS, "id", map_document_review);
    set(&mut mapped, table::REVIEWS, document_reviews.len());

    let alert_rows = reader.alerts()?;
    set(&mut sources, table::ALERTS, alert_rows.len());
    let alerts = read!(alert_rows, table::ALERTS, "id", map_alert);
    set(&mut mapped, table::ALERTS, alerts.len());
    let alert_ids: HashSet<&str> = alerts.iter().map(|a| a.id.as_str()).collect();

    let action_rows = reader.actions()?;
    set(&mut sources, table::ACTIONS, action_rows.len());
    let mut actions = read!(action_rows, table::ACTIONS, "id", map_action);
    actions.retain(|action| {
        let known = alert_ids.contains(action.alert_id.as_str());
        if !known {
            problems.push(
                Problem::new("action_alert_missing")
                    .tenant(&tenant)
                    .table("preventive_actions")
                    .id(action.id.clone()),
            );
        }
        known
    });
    set(&mut mapped, table::ACTIONS, actions.len());
    let action_ids: HashSet<&str> = actions.iter().map(|a| a.id.as_str()).collect();

    let log_rows = reader.action_log()?;
    set(&mut sources, table::ACTION_LOG, log_rows.len());
    let mut action_log = read!(log_rows, table::ACTION_LOG, "id", map_action_log);
    action_log.retain(|entry| {
        let known = action_ids.contains(entry.action_id.as_str());
        if !known {
            problems.push(
                Problem::new("action_log_action_missing")
                    .tenant(&tenant)
                    .table("preventive_action_log")
                    .id(entry.id.clone()),
            );
        }
        known
    });
    set(&mut mapped, table::ACTION_LOG, action_log.len());

    let batch = TenantBatch {
        records,
        audit,
        irsa_config,
        snapshots,
        attachments,
        document_reviews,
        alerts,
        actions,
        action_log,
    };
    let source_checksums = checksums_of(&batch_fingerprints(&batch));
    Ok(Prepared {
        tenant_id: tenant,
        label: scope.label.clone(),
        present: reader.present(),
        source: sources,
        mapped,
        objects,
        problems,
        batch,
        bytes,
        source_checksums,
    })
}

/// `Map.set`: a repeated key keeps its position with the last value.
fn map_set<T>(entries: &mut Vec<(String, T)>, key: &str, value: T) {
    match entries.iter_mut().find(|(known, _)| known == key) {
        Some(slot) => slot.1 = value,
        None => entries.push((key.to_owned(), value)),
    }
}

fn map_get<'a, T>(entries: &'a [(String, T)], key: &str) -> Option<&'a T> {
    entries
        .iter()
        .find(|(known, _)| known == key)
        .map(|(_, value)| value)
}

/// `alreadyPresent`.
fn already_present(rows: Vec<Skipped>, into: &mut Vec<Problem>, tenant: Option<&str>) {
    for row in rows {
        let mut item = Problem::new("row_already_present")
            .table(&row.table)
            .id(row.id);
        if let Some(tenant) = tenant.filter(|id| !id.is_empty()) {
            item = item.tenant(tenant);
        }
        into.push(item);
    }
}

fn grant_key(grant: &Grant) -> String {
    format!("{}@{}", grant.username, grant.tenant_id)
}

/// The whole-run comparison of `verify`: accounts, tenants and grants.
fn verify_identity(
    store: &mut Store,
    users: &[crate::mapping::User],
    tenants: &[Scope],
    grants: &[Grant],
    problems: &mut Vec<Problem>,
) -> Result<(), Fatal> {
    let target = store.identity()?;
    let stored_users: HashMap<&str, _> = target
        .users
        .iter()
        .map(|u| (u.username.as_str(), u))
        .collect();
    for user in users {
        let at = |code| Problem::new(code).table("users").id(user.username.clone());
        match stored_users.get(user.username.as_str()) {
            None => problems.push(at("verify_user_missing")),
            Some(stored) => {
                let same = stored.full_name == user.full_name
                    && stored.password_hash == user.password_hash
                    && stored.role == user.role
                    && stored.active == user.active
                    && stored.totp_present == user.totp_secret.is_some()
                    && stored.totp_enabled == (user.totp_enabled && user.totp_secret.is_some());
                if !same {
                    problems.push(at("verify_user_mismatch"));
                }
            }
        }
    }
    let usernames: HashSet<&str> = users.iter().map(|u| u.username.as_str()).collect();
    for stored in &target.users {
        if !usernames.contains(stored.username.as_str()) {
            problems.push(
                Problem::new("verify_row_unexpected")
                    .table("users")
                    .id(stored.username.clone()),
            );
        }
    }

    let stored_tenants: HashMap<String, &Scope> = target
        .tenants
        .iter()
        .map(|t| (format_tenant_id(&t.company, &t.project), t))
        .collect();
    for tenant in tenants {
        let id = tenant.tenant_id();
        let at = |code| {
            Problem::new(code)
                .tenant(&id)
                .table("tenants")
                .id(id.clone())
        };
        match stored_tenants.get(&id) {
            None => problems.push(at("verify_tenant_missing")),
            Some(stored) if stored.label != tenant.label => {
                problems.push(at("verify_tenant_mismatch"));
            }
            Some(_) => {}
        }
    }

    let mapped: HashSet<String> = grants.iter().map(grant_key).collect();
    let stored: HashSet<String> = target.grants.iter().map(grant_key).collect();
    let tenant_ids: HashSet<String> = tenants.iter().map(Scope::tenant_id).collect();
    let row = |code, grant: &Grant| {
        Problem::new(code)
            .tenant(&grant.tenant_id)
            .table("grants")
            .id(grant_key(grant))
    };
    for grant in grants {
        if !stored.contains(&grant_key(grant)) {
            problems.push(row("verify_grant_missing", grant));
        }
    }
    for grant in &target.grants {
        if tenant_ids.contains(&grant.tenant_id) && !mapped.contains(&grant_key(grant)) {
            problems.push(row("verify_row_unexpected", grant));
        }
    }
    Ok(())
}

/// Reads one tenant back and, under `verify`, compares it.
fn read_back(
    store: &mut Store,
    storage: &Storage,
    entry: &mut Prepared,
    verify: bool,
    written: Counts,
) -> Result<TenantReport, Fatal> {
    let tenant = entry.tenant_id.clone();
    let target = store.tenant_counts(&tenant)?;
    let mut target_checksums = None;
    if verify {
        let checksums = checksums_of(&store.row_fingerprints(&tenant)?);
        let tables = || TENANT_TABLES.iter().enumerate();
        for (i, table_name) in tables() {
            if checksums.get(i) != entry.source_checksums.get(i) {
                entry.problems.push(
                    Problem::new("verify_checksum_mismatch")
                        .tenant(&tenant)
                        .table(table_name),
                );
            }
        }
        for (i, table_name) in tables() {
            if entry.mapped.get(i) != target.get(i) {
                entry.problems.push(
                    Problem::new("verify_count_mismatch")
                        .tenant(&tenant)
                        .table(table_name)
                        .count(target.get(i).copied().unwrap_or(0)),
                );
            }
        }
        for digest in store.attachment_digests(&tenant)? {
            let at = |code| {
                Problem::new(code)
                    .tenant(&tenant)
                    .table("attachments")
                    .id(digest.id.clone())
            };
            let bytes = storage
                .get(&digest.storage_key)
                .map_err(|_| Fatal::named("Error"))?;
            match bytes {
                None => entry.problems.push(at("verify_attachment_missing")),
                Some(bytes) if Some(sha256_hex(&bytes)) != digest.sha256 => {
                    entry.problems.push(at("verify_attachment_mismatch"));
                }
                Some(_) => entry.objects.verified += 1,
            }
        }
        target_checksums = Some(checksums);
    }
    Ok(TenantReport {
        tenant_id: tenant,
        label: entry.label.clone(),
        source_present: entry.present,
        source: entry.source,
        mapped: entry.mapped,
        written,
        target,
        objects: entry.objects,
        source_checksums: entry.source_checksums.clone(),
        target_checksums,
        problems: entry.problems.clone(),
    })
}

/// Writes each tenant; a failing tenant is reported and the others still run.
fn apply_tenants(
    store: &mut Store,
    storage: &Storage,
    prepared: &mut [Prepared],
    existing: &[(String, Counts)],
    written: &mut Vec<(String, Counts)>,
) {
    for entry in prepared {
        let tenant = entry.tenant_id.clone();
        let occupied = map_get(existing, &tenant).map_or(0, total);
        if occupied > 0 {
            // Only reachable with --allow-non-empty. audit and irsa_snapshots have generated
            // keys, so writing again would duplicate them: the tenant is skipped as a whole.
            entry.problems.push(
                Problem::new("tenant_not_empty")
                    .tenant(&tenant)
                    .count(occupied),
            );
            continue;
        }
        let outcome = (|| -> Result<(), ()> {
            // Objects go before the metadata transaction; keys are deterministic, so a retried
            // run reuses the same key instead of leaving a second copy behind.
            for attachment in &entry.batch.attachments {
                let Some(data) = entry.bytes.get(&attachment.id) else {
                    continue;
                };
                storage
                    .put(&attachment.storage_key, data, &attachment.content_type)
                    .map_err(|_| ())?;
                entry.objects.copied += 1;
            }
            let result = store.write_tenant(&tenant, &entry.batch).map_err(|_| ())?;
            map_set(written, &tenant, result.counts);
            already_present(result.skipped, &mut entry.problems, Some(&tenant));
            Ok(())
        })();
        if outcome.is_err() {
            entry
                .problems
                .push(Problem::new("tenant_write_failed").tenant(&tenant));
        }
    }
}

/// Every collaborator of a run.
pub struct Deps<'a> {
    /// The legacy installation.
    pub source: &'a Source,
    /// The target database.
    pub store: &'a mut Store,
    /// Object storage.
    pub storage: &'a Storage,
    /// `new Date().toISOString()`.
    pub now: &'a dyn Fn() -> String,
}

/// `runMigration`.
///
/// # Errors
/// Everything TypeScript does not catch: the run stops and no report is written.
#[allow(clippy::too_many_lines)]
pub fn run_migration(deps: Deps<'_>, options: Options<'_>) -> Result<Report, Fatal> {
    let Deps {
        source,
        store,
        storage,
        now,
    } = deps;
    let started_at = now();
    let mut global = Vec::new();

    let scopes = source.scopes()?;
    let wanted = options.only;
    let mut tenants = Vec::new();
    let listed: Vec<&Scope> = scopes
        .iter()
        .filter(|s| wanted.is_empty() || wanted.contains(&s.tenant_id()))
        .collect();
    let mut selected = Vec::new();
    for (index, scope) in listed.into_iter().enumerate() {
        if scope.is_valid() {
            tenants.push(scope.clone());
            selected.push(scope);
        } else {
            global.push(
                Problem::new("tenant_row_invalid")
                    .table("tenants")
                    .id(format!("#{index}")),
            );
        }
    }
    for id in wanted {
        if !scopes.iter().any(|s| s.tenant_id() == *id) {
            global.push(Problem::new("tenant_not_in_directory").tenant(id));
        }
    }

    let user_rows = source.users()?;
    let users = collect(&user_rows, map_user, |code, index| {
        global.push(
            Problem::new(code)
                .table("users")
                .id(id_at(&user_rows, "username", index)),
        );
    })?;
    let usernames: HashSet<&str> = users.iter().map(|u| u.username.as_str()).collect();
    let tenant_ids: HashSet<String> = tenants.iter().map(Scope::tenant_id).collect();
    let grant_rows = source.grants()?;
    let mut grants = Vec::new();
    for row in &grant_rows {
        let at = |code| {
            Problem::new(code)
                .table("grants")
                .id(row.username.clone())
                .tenant(&row.tenant_id)
        };
        if !usernames.contains(row.username.as_str()) {
            global.push(at("grant_user_unknown"));
        } else if !tenant_ids.contains(&row.tenant_id) {
            global.push(at("grant_tenant_unknown"));
        } else {
            grants.push(Grant {
                username: row.username.clone(),
                tenant_id: row.tenant_id.clone(),
            });
        }
    }

    let sessions_skipped = source.session_count()?;
    if sessions_skipped > 0 {
        global.push(Problem::new("sessions_not_migrated").count(sessions_skipped));
    }

    let mut prepared = Vec::with_capacity(selected.len());
    for scope in selected {
        prepared.push(prepare_tenant(source, scope)?);
    }

    // Emptiness guard.
    let before = store.global_counts()?;
    let mut existing: Vec<(String, Counts)> = Vec::new();
    for entry in &prepared {
        let counts = store.tenant_counts(&entry.tenant_id)?;
        map_set(&mut existing, &entry.tenant_id, counts);
    }
    let occupied = existing.iter().filter(|(_, counts)| total(counts) > 0);
    let identity_occupied = before.users > 0 || before.grants > 0;
    let refuse = options.mode == Mode::Apply
        && !options.allow_non_empty
        && (occupied.clone().count() > 0 || identity_occupied);
    if refuse {
        for (tenant, counts) in occupied {
            global.push(
                Problem::new("target_not_empty")
                    .tenant(tenant)
                    .table("tenant")
                    .count(total(counts)),
            );
        }
        if identity_occupied {
            global.push(
                Problem::new("target_not_empty")
                    .table("users")
                    .count(before.users),
            );
        }
    }

    let mut report_users = CountPair {
        source: user_rows.len(),
        mapped: users.len(),
        written: 0,
    };
    let mut report_tenants = CountPair {
        source: scopes.len(),
        mapped: tenants.len(),
        written: 0,
    };
    let mut report_grants = CountPair {
        source: grant_rows.len(),
        mapped: grants.len(),
        written: 0,
    };
    let applied = options.mode == Mode::Apply && !refuse;
    let mut written: Vec<(String, Counts)> = Vec::new();

    if applied {
        let batch = GlobalBatch {
            tenants: &tenants,
            users: &users,
            grants: &grants,
        };
        match store.write_global(batch) {
            Ok(result) => {
                report_users.written = result.counts.users;
                report_tenants.written = result.counts.tenants;
                report_grants.written = result.counts.grants;
                already_present(result.skipped, &mut global, None);
                apply_tenants(store, storage, &mut prepared, &existing, &mut written);
            }
            // Codes only: a driver message could quote the rejected values.
            Err(_) => global.push(Problem::new("identity_write_failed").table("users")),
        }
    }

    let mut tenant_reports = Vec::with_capacity(prepared.len());
    for entry in &mut prepared {
        let counts = map_get(&written, &entry.tenant_id)
            .copied()
            .unwrap_or([0; 9]);
        tenant_reports.push(read_back(
            store,
            storage,
            entry,
            options.mode == Mode::Verify,
            counts,
        )?);
    }

    if options.mode == Mode::Verify {
        verify_identity(store, &users, &tenants, &grants, &mut global)?;
    }

    let ok = !global
        .iter()
        .chain(tenant_reports.iter().flat_map(|t| &t.problems))
        .any(Problem::is_error);
    Ok(Report {
        mode: options.mode,
        started_at,
        finished_at: now(),
        applied,
        users: report_users,
        tenants: report_tenants,
        grants: report_grants,
        sessions_skipped,
        tenant_reports,
        problems: global,
        ok,
    })
}

fn counts_json(counts: &Counts) -> Json {
    Json::object(
        TENANT_TABLES
            .iter()
            .zip(counts)
            .map(|(table, count)| (*table, number(*count)))
            .collect(),
    )
}

fn checksums_json(checksums: &[String; 9]) -> Json {
    Json::object(
        TENANT_TABLES
            .iter()
            .zip(checksums)
            .map(|(table, checksum)| (*table, Json::text(checksum)))
            .collect(),
    )
}

fn pair_json(pair: CountPair) -> Json {
    Json::object(vec![
        ("source", number(pair.source)),
        ("mapped", number(pair.mapped)),
        ("written", number(pair.written)),
    ])
}

fn tenant_json(t: &TenantReport) -> Json {
    Json::object(vec![
        ("tenantId", Json::text(&t.tenant_id)),
        ("label", Json::text(&t.label)),
        ("sourcePresent", Json::Bool(t.source_present)),
        ("source", counts_json(&t.source)),
        ("mapped", counts_json(&t.mapped)),
        ("written", counts_json(&t.written)),
        ("target", counts_json(&t.target)),
        (
            "objects",
            Json::object(vec![
                ("expected", number(t.objects.expected)),
                ("copied", number(t.objects.copied)),
                ("verified", number(t.objects.verified)),
                ("missing", number(t.objects.missing)),
                ("mismatched", number(t.objects.mismatched)),
            ]),
        ),
        (
            "checksums",
            Json::object(vec![
                ("source", checksums_json(&t.source_checksums)),
                (
                    "target",
                    t.target_checksums
                        .as_ref()
                        .map_or(Json::Null, checksums_json),
                ),
            ]),
        ),
        (
            "problems",
            Json::Arr(t.problems.iter().map(Problem::to_json).collect()),
        ),
    ])
}

impl Report {
    /// `reportJson`: counts, codes and identifiers only.
    #[must_use]
    pub fn to_json(&self) -> String {
        json::canonical(&Json::object(vec![
            ("mode", Json::text(self.mode.as_str())),
            ("startedAt", Json::text(&self.started_at)),
            ("finishedAt", Json::text(&self.finished_at)),
            ("applied", Json::Bool(self.applied)),
            (
                "identity",
                Json::object(vec![
                    ("users", pair_json(self.users)),
                    ("tenants", pair_json(self.tenants)),
                    ("grants", pair_json(self.grants)),
                    ("sessionsSkipped", number(self.sessions_skipped)),
                ]),
            ),
            (
                "tenants",
                Json::Arr(self.tenant_reports.iter().map(tenant_json).collect()),
            ),
            (
                "problems",
                Json::Arr(self.problems.iter().map(Problem::to_json).collect()),
            ),
            ("ok", Json::Bool(self.ok)),
        ]))
    }

    /// `summarize`: counts only, never contents.
    #[must_use]
    pub fn summarize(&self) -> String {
        let errors: Vec<&Problem> = self
            .problems
            .iter()
            .chain(self.tenant_reports.iter().flat_map(|t| &t.problems))
            .filter(|p| p.is_error())
            .collect();
        let mut codes: Vec<(Code, usize)> = Vec::new();
        for problem in &errors {
            match codes.iter_mut().find(|(code, _)| *code == problem.code) {
                Some(entry) => entry.1 += 1,
                None => codes.push((problem.code, 1)),
            }
        }
        let mut out = format!(
            "mode={} applied={} ok={} errors={}\nusers {}/{}, tenants {}/{}, grants {}/{}, sessions skipped {}",
            self.mode.as_str(),
            self.applied,
            self.ok,
            errors.len(),
            self.users.mapped,
            self.users.source,
            self.tenants.mapped,
            self.tenants.source,
            self.grants.mapped,
            self.grants.source,
            self.sessions_skipped,
        );
        for t in &self.tenant_reports {
            let _ = write!(
                out,
                "\n{}: source {} / mapped {} / written {} / target {} / objects {}+{} of {}",
                t.tenant_id,
                total(&t.source),
                total(&t.mapped),
                total(&t.written),
                total(&t.target),
                t.objects.copied,
                t.objects.verified,
                t.objects.expected,
            );
        }
        for (code, count) in codes {
            let _ = write!(out, "\nerror {code} x{count}");
        }
        out
    }
}
