//! `infrastructure/sql-target-store.ts`: the PostgreSQL side. Global tables are written in one
//! transaction as the owner; each tenant's tables in one tenant transaction under forced RLS.
//!
//! Keyed inserts are `ON CONFLICT DO NOTHING`, and every key that already existed comes back as a
//! skipped row. Timestamps, numbers and JSON travel as text and are cast in SQL, so PostgreSQL
//! parses exactly the strings TypeScript sends.

use std::time::SystemTime;

use postgres::types::ToSql;
use postgres::{Client, Row as PgRow, Transaction};
use sipges_indicators::js::number_to_string;
use sipges_rotate_data_key::cipher::Cipher;
use sipges_tools_common::db;
use sipges_tools_common::tenant::{TenantError, with_tenant};
use sipges_tools_common::time::{epoch_ms, truncate_ms};

use crate::json::{self, Json};
use crate::mapping::{
    Action, ActionLog, Alert, Attachment, Audit, DocumentReview, Fatal, Ms, Record, Scope,
    Snapshot, User, fingerprint_action, fingerprint_action_log, fingerprint_alert,
    fingerprint_attachment, fingerprint_audit, fingerprint_record, fingerprint_review,
    fingerprint_snapshot, iso,
};
use crate::value::js_number;

/// `TENANT_TABLES`, in report order.
pub const TENANT_TABLES: [&str; 9] = [
    "module_records",
    "audit",
    "irsa_configs",
    "irsa_snapshots",
    "attachments",
    "document_review",
    "digital_alert_reviews",
    "preventive_actions",
    "preventive_action_log",
];

/// Index of each table in [`TENANT_TABLES`].
pub mod table {
    /// `module_records`.
    pub const RECORDS: usize = 0;
    /// `audit`.
    pub const AUDIT: usize = 1;
    /// `irsa_configs`.
    pub const IRSA_CONFIGS: usize = 2;
    /// `irsa_snapshots`.
    pub const SNAPSHOTS: usize = 3;
    /// `attachments`.
    pub const ATTACHMENTS: usize = 4;
    /// `document_review`.
    pub const REVIEWS: usize = 5;
    /// `digital_alert_reviews`.
    pub const ALERTS: usize = 6;
    /// `preventive_actions`.
    pub const ACTIONS: usize = 7;
    /// `preventive_action_log`.
    pub const ACTION_LOG: usize = 8;
}

/// `TableCounts`.
pub type Counts = [usize; 9];

/// `GlobalCounts`.
#[derive(Clone, Copy, Debug, Default)]
pub struct GlobalCounts {
    /// `users`.
    pub users: usize,
    /// `tenants`.
    pub tenants: usize,
    /// `grants`.
    pub grants: usize,
}

/// A keyed row whose insert wrote nothing because the key already existed.
#[derive(Clone, Debug)]
pub struct Skipped {
    /// Target table.
    pub table: String,
    /// The row's key.
    pub id: String,
}

/// `WriteResult`.
#[derive(Clone, Debug)]
pub struct Written<C> {
    /// Rows written.
    pub counts: C,
    /// Keys already present.
    pub skipped: Vec<Skipped>,
}

/// `TargetGrant`.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct Grant {
    /// Account.
    pub username: String,
    /// `company/project`.
    pub tenant_id: String,
}

/// `GlobalBatch`.
#[derive(Clone, Copy, Debug)]
pub struct GlobalBatch<'a> {
    /// `tenants`.
    pub tenants: &'a [Scope],
    /// `users`.
    pub users: &'a [User],
    /// `grants`.
    pub grants: &'a [Grant],
}

/// `TenantBatch`.
#[derive(Clone, Debug, Default)]
pub struct TenantBatch {
    /// `module_records`.
    pub records: Vec<Record>,
    /// `audit`.
    pub audit: Vec<Audit>,
    /// `irsa_configs`.
    pub irsa_config: Option<Json>,
    /// `irsa_snapshots`.
    pub snapshots: Vec<Snapshot>,
    /// `attachments`.
    pub attachments: Vec<Attachment>,
    /// `document_review`.
    pub document_reviews: Vec<DocumentReview>,
    /// `digital_alert_reviews`.
    pub alerts: Vec<Alert>,
    /// `preventive_actions`.
    pub actions: Vec<Action>,
    /// `preventive_action_log`.
    pub action_log: Vec<ActionLog>,
}

/// What verify compares for an account; held in memory, never reported.
#[derive(Clone, Debug)]
pub struct TargetUser {
    /// Account.
    pub username: String,
    /// Display name.
    pub full_name: String,
    /// Password hash.
    pub password_hash: String,
    /// Role.
    pub role: String,
    /// Active flag.
    pub active: bool,
    /// TOTP flag.
    pub totp_enabled: bool,
    /// A sealed secret exists.
    pub totp_present: bool,
}

/// `TargetIdentity`.
#[derive(Clone, Debug, Default)]
pub struct Identity {
    /// `users`.
    pub users: Vec<TargetUser>,
    /// `tenants`.
    pub tenants: Vec<Scope>,
    /// `grants`.
    pub grants: Vec<Grant>,
}

/// `TargetAttachmentDigest`.
#[derive(Clone, Debug)]
pub struct AttachmentDigest {
    /// Attachment id.
    pub id: String,
    /// Stored digest; `None` for a row without one.
    pub sha256: Option<String>,
    /// Object key.
    pub storage_key: String,
}

/// A failure on the PostgreSQL side.
#[derive(Debug)]
pub enum StoreError {
    /// Driver error.
    Driver(postgres::Error),
    /// Invalid tenant id.
    Tenant,
    /// Reconnecting failed.
    Connect(db::ConnectError),
    /// A TOTP secret could not be sealed.
    Seal,
    /// A JSON column did not parse.
    Json,
}

impl From<postgres::Error> for StoreError {
    fn from(error: postgres::Error) -> Self {
        Self::Driver(error)
    }
}

impl From<TenantError> for StoreError {
    fn from(error: TenantError) -> Self {
        match error {
            TenantError::Driver(e) => Self::Driver(e),
            TenantError::Invalid(_) => Self::Tenant,
        }
    }
}

impl From<StoreError> for Fatal {
    fn from(error: StoreError) -> Self {
        Self::named(match error {
            StoreError::Driver(e) if e.as_db_error().is_some() => "PostgresError",
            StoreError::Connect(e) => db::error_name(&e),
            StoreError::Json => "SyntaxError",
            _ => "Error",
        })
    }
}

/// `json(value)`: `JSON.parse(String(value))`.
fn read_json(row: &PgRow, column: &str) -> Result<Json, StoreError> {
    let text: String = row.try_get(column)?;
    json::parse(&text)
        .map(|parsed| parsed.value)
        .map_err(|_| StoreError::Json)
}

/// A `timestamptz` as postgres.js reads it: a `Date`, whole milliseconds.
fn read_ms(row: &PgRow, column: &str) -> Result<Ms, StoreError> {
    let at: SystemTime = row.try_get(column)?;
    Ok(i64::try_from(epoch_ms(truncate_ms(at))).unwrap_or(i64::MAX))
}

/// `Number(r[column])`, or the `Date` of a nullable column.
fn read_maybe_ms(row: &PgRow, column: &str) -> Result<Option<Ms>, StoreError> {
    let at: Option<SystemTime> = row.try_get(column)?;
    Ok(at.map(|at| i64::try_from(epoch_ms(truncate_ms(at))).unwrap_or(i64::MAX)))
}

fn count(row: Option<&PgRow>) -> Result<usize, StoreError> {
    let n: i64 = row.map_or(Ok(0), |row| row.try_get("n"))?;
    Ok(usize::try_from(n).unwrap_or(0))
}

/// Rows a table's one statement writes; `key` names a keyed row in the skipped list.
struct Tally<'a> {
    counts: &'a mut Counts,
    skipped: &'a mut Vec<Skipped>,
}

impl Tally<'_> {
    fn bump(&mut self, index: usize, rows: usize, key: Option<&str>) {
        if let Some(slot) = self.counts.get_mut(index) {
            *slot += rows;
        }
        if let (Some(id), 0) = (key, rows) {
            self.skipped.push(Skipped {
                table: TENANT_TABLES
                    .get(index)
                    .copied()
                    .unwrap_or_default()
                    .to_owned(),
                id: id.to_owned(),
            });
        }
    }
}

fn write_records(
    tx: &mut Transaction<'_>,
    rows: &[Record],
    tally: &mut Tally<'_>,
) -> Result<(), StoreError> {
    if rows.is_empty() {
        return Ok(());
    }
    let statement = tx.prepare(
        "INSERT INTO module_records (tenant_id, module, id, payload, created_at, updated_at)
         VALUES (current_setting('app.tenant_id', true), $1, $2, $3::text::jsonb,
           $4::text::timestamptz, $5::text::timestamptz)
         ON CONFLICT DO NOTHING RETURNING id",
    )?;
    for record in rows {
        let written = tx.query(
            &statement,
            &[
                &record.module,
                &record.id,
                &json::stringify(&record.payload),
                &iso(record.created_at),
                &iso(record.updated_at),
            ],
        )?;
        let key = format!("{}/{}", record.module, record.id);
        tally.bump(table::RECORDS, written.len(), Some(&key));
    }
    Ok(())
}

fn write_audit(
    tx: &mut Transaction<'_>,
    rows: &[Audit],
    tally: &mut Tally<'_>,
) -> Result<(), StoreError> {
    if rows.is_empty() {
        return Ok(());
    }
    let statement = tx.prepare(
        "INSERT INTO audit (tenant_id, ts, module, record_id, action, detail)
         VALUES (current_setting('app.tenant_id', true), $1::text::timestamptz, $2, $3, $4, $5)
         RETURNING id",
    )?;
    for entry in rows {
        let written = tx.query(
            &statement,
            &[
                &iso(entry.ts),
                &entry.module,
                &entry.record_id,
                &entry.action,
                &entry.detail,
            ],
        )?;
        tally.bump(table::AUDIT, written.len(), None);
    }
    Ok(())
}

fn write_snapshots(
    tx: &mut Transaction<'_>,
    tenant: &str,
    rows: &[Snapshot],
    tally: &mut Tally<'_>,
) -> Result<(), StoreError> {
    if rows.is_empty() {
        return Ok(());
    }
    // Ids are generated: legacy ids are per-file. Rows go in legacy id order.
    let statement = tx.prepare(
        "INSERT INTO irsa_snapshots (tenant_id, ts, irsa, level, scores, config_version, note)
         VALUES ($1, $2::text::timestamptz, $3::text::double precision, $4, $5::text::json, $6, $7)
         RETURNING id",
    )?;
    for snapshot in rows {
        let written = tx.query(
            &statement,
            &[
                &tenant,
                &iso(snapshot.ts),
                &number_to_string(snapshot.irsa),
                &snapshot.level,
                &json::stringify(&snapshot.scores),
                &snapshot.config_version,
                &snapshot.note,
            ],
        )?;
        tally.bump(table::SNAPSHOTS, written.len(), None);
    }
    Ok(())
}

fn write_attachments(
    tx: &mut Transaction<'_>,
    rows: &[Attachment],
    tally: &mut Tally<'_>,
) -> Result<(), StoreError> {
    if rows.is_empty() {
        return Ok(());
    }
    let statement = tx.prepare(
        "INSERT INTO attachments (tenant_id, id, storage_key, original_name, content_type,
           size_bytes, sha256, linked_module, record_module, linked_record_id, document_type,
           author, verification, notes, project_id, project_name, created_at)
         VALUES (current_setting('app.tenant_id', true), $1, $2, $3, $4, $5::text::bigint, $6, $7,
           $8, $9, $10, $11, $12, $13, $14, $15, $16::text::timestamptz)
         ON CONFLICT DO NOTHING RETURNING id",
    )?;
    for a in rows {
        let params: [&(dyn ToSql + Sync); 16] = [
            &a.id,
            &a.storage_key,
            &a.original_name,
            &a.content_type,
            &number_to_string(a.size_bytes),
            &a.sha256,
            &a.linked_module,
            &a.record_module,
            &a.linked_record_id,
            &a.document_type,
            &a.author,
            &a.verification,
            &a.notes,
            &a.project_id,
            &a.project_name,
            &iso(a.created_at),
        ];
        let written = tx.query(&statement, &params)?;
        tally.bump(table::ATTACHMENTS, written.len(), Some(&a.id));
    }
    Ok(())
}

fn write_reviews(
    tx: &mut Transaction<'_>,
    rows: &[DocumentReview],
    tally: &mut Tally<'_>,
) -> Result<(), StoreError> {
    if rows.is_empty() {
        return Ok(());
    }
    let statement = tx.prepare(
        "INSERT INTO document_review (tenant_id, id, project_id, source_file, source_sha256,
           location, theme, excerpt, action, status, reviewer, note, created_at, updated_at)
         VALUES (current_setting('app.tenant_id', true), $1, $2, $3, $4, $5, $6, $7, $8, $9,
           $10, $11, $12::text::timestamptz, $13::text::timestamptz)
         ON CONFLICT DO NOTHING RETURNING id",
    )?;
    for r in rows {
        let params: [&(dyn ToSql + Sync); 13] = [
            &r.id,
            &r.project_id,
            &r.source_file,
            &r.source_sha256,
            &r.location,
            &r.theme,
            &r.excerpt,
            &r.action,
            &r.status,
            &r.reviewer,
            &r.note,
            &iso(r.created_at),
            &iso(r.updated_at),
        ];
        let written = tx.query(&statement, &params)?;
        tally.bump(table::REVIEWS, written.len(), Some(&r.id));
    }
    Ok(())
}

fn write_alerts(
    tx: &mut Transaction<'_>,
    rows: &[Alert],
    tally: &mut Tally<'_>,
) -> Result<(), StoreError> {
    if rows.is_empty() {
        return Ok(());
    }
    let statement = tx.prepare(
        "INSERT INTO digital_alert_reviews (tenant_id, id, project_id, created_at, source_url,
           source_type, excerpt, sha256, level, score, method, themes, signals, suggestions,
           semantic_active, status, analyst_note, reviewer_note, reviewed_at)
         VALUES (current_setting('app.tenant_id', true), $1, $2, $3::text::timestamptz, $4, $5,
           $6, $7, $8, $9::text::integer, $10, $11::text::jsonb, $12::text::jsonb,
           $13::text::jsonb, $14, $15, $16, $17, $18::text::timestamptz)
         ON CONFLICT DO NOTHING RETURNING id",
    )?;
    for a in rows {
        let reviewed_at = a.reviewed_at.map(iso);
        let params: [&(dyn ToSql + Sync); 18] = [
            &a.id,
            &a.project_id,
            &iso(a.created_at),
            &a.source_url,
            &a.source_type,
            &a.excerpt,
            &a.sha256,
            &a.level,
            &number_to_string(a.score),
            &a.method,
            &json::stringify(&a.themes),
            &json::stringify(&a.signals),
            &json::stringify(&a.suggestions),
            &a.semantic_active,
            &a.status,
            &a.analyst_note,
            &a.reviewer_note,
            &reviewed_at,
        ];
        let written = tx.query(&statement, &params)?;
        tally.bump(table::ALERTS, written.len(), Some(&a.id));
    }
    Ok(())
}

fn write_actions(
    tx: &mut Transaction<'_>,
    rows: &[Action],
    tally: &mut Tally<'_>,
) -> Result<(), StoreError> {
    if rows.is_empty() {
        return Ok(());
    }
    let statement = tx.prepare(
        "INSERT INTO preventive_actions (tenant_id, id, project_id, alert_id, title,
           responsible, due_date, description, status, progress, created_at, updated_at)
         VALUES (current_setting('app.tenant_id', true), $1, $2, $3, $4, $5, $6, $7, $8,
           $9::text::integer, $10::text::timestamptz, $11::text::timestamptz)
         ON CONFLICT DO NOTHING RETURNING id",
    )?;
    for a in rows {
        let params: [&(dyn ToSql + Sync); 11] = [
            &a.id,
            &a.project_id,
            &a.alert_id,
            &a.title,
            &a.responsible,
            &a.due_date,
            &a.description,
            &a.status,
            &number_to_string(a.progress),
            &iso(a.created_at),
            &iso(a.updated_at),
        ];
        let written = tx.query(&statement, &params)?;
        tally.bump(table::ACTIONS, written.len(), Some(&a.id));
    }
    Ok(())
}

fn write_action_log(
    tx: &mut Transaction<'_>,
    rows: &[ActionLog],
    tally: &mut Tally<'_>,
) -> Result<(), StoreError> {
    if rows.is_empty() {
        return Ok(());
    }
    let statement = tx.prepare(
        "INSERT INTO preventive_action_log (tenant_id, id, action_id, created_at, status,
           progress, note, evidence_url)
         VALUES (current_setting('app.tenant_id', true), $1, $2, $3::text::timestamptz, $4,
           $5::text::integer, $6, $7)
         ON CONFLICT DO NOTHING RETURNING id",
    )?;
    for l in rows {
        let written = tx.query(
            &statement,
            &[
                &l.id,
                &l.action_id,
                &iso(l.created_at),
                &l.status,
                &number_to_string(l.progress),
                &l.note,
                &l.evidence_url,
            ],
        )?;
        tally.bump(table::ACTION_LOG, written.len(), Some(&l.id));
    }
    Ok(())
}

/// `rowFingerprints` of one tenant, table by table.
#[allow(clippy::too_many_lines)]
fn fingerprints(tx: &mut Transaction<'_>, tenant: &str) -> Result<[Vec<String>; 9], StoreError> {
    let text = |row: &PgRow, column: &str| row.try_get::<_, String>(column);
    let maybe = |row: &PgRow, column: &str| row.try_get::<_, Option<String>>(column);
    let mut out: [Vec<String>; 9] = Default::default();
    let rows = tx.query(
        "SELECT module, id, payload::text AS payload, created_at, updated_at FROM module_records
         WHERE tenant_id = $1",
        &[&tenant],
    )?;
    if let Some(slot) = out.get_mut(table::RECORDS) {
        for r in &rows {
            slot.push(fingerprint_record(&Record {
                module: text(r, "module")?,
                id: text(r, "id")?,
                payload: read_json(r, "payload")?,
                created_at: read_ms(r, "created_at")?,
                updated_at: read_ms(r, "updated_at")?,
            }));
        }
    }
    let rows = tx.query(
        "SELECT ts, module, record_id, action, detail FROM audit WHERE tenant_id = $1",
        &[&tenant],
    )?;
    if let Some(slot) = out.get_mut(table::AUDIT) {
        for r in &rows {
            slot.push(fingerprint_audit(&Audit {
                ts: read_ms(r, "ts")?,
                module: text(r, "module")?,
                record_id: maybe(r, "record_id")?,
                action: text(r, "action")?,
                detail: maybe(r, "detail")?,
            }));
        }
    }
    let rows = tx.query(
        "SELECT config::text AS config FROM irsa_configs WHERE tenant_id = $1",
        &[&tenant],
    )?;
    if let Some(slot) = out.get_mut(table::IRSA_CONFIGS) {
        for r in &rows {
            slot.push(json::canonical(&read_json(r, "config")?));
        }
    }
    let rows = tx.query(
        "SELECT ts, irsa, level, scores::text AS scores, config_version, note FROM irsa_snapshots
         WHERE tenant_id = $1",
        &[&tenant],
    )?;
    if let Some(slot) = out.get_mut(table::SNAPSHOTS) {
        for r in &rows {
            slot.push(fingerprint_snapshot(&Snapshot {
                ts: read_ms(r, "ts")?,
                irsa: r.try_get("irsa")?,
                level: text(r, "level")?,
                scores: read_json(r, "scores")?,
                config_version: maybe(r, "config_version")?,
                note: maybe(r, "note")?,
            }));
        }
    }
    let rows = tx.query(
        "SELECT id, storage_key, original_name, content_type, size_bytes::text AS size_bytes,
           sha256, linked_module, record_module, linked_record_id, document_type, author,
           verification, notes, project_id, project_name, created_at FROM attachments
         WHERE tenant_id = $1",
        &[&tenant],
    )?;
    if let Some(slot) = out.get_mut(table::ATTACHMENTS) {
        for r in &rows {
            slot.push(fingerprint_attachment(&Attachment {
                id: text(r, "id")?,
                storage_key: text(r, "storage_key")?,
                legacy_stored_name: String::new(),
                original_name: text(r, "original_name")?,
                content_type: text(r, "content_type")?,
                size_bytes: js_number(&text(r, "size_bytes")?),
                sha256: maybe(r, "sha256")?,
                linked_module: text(r, "linked_module")?,
                record_module: text(r, "record_module")?,
                linked_record_id: text(r, "linked_record_id")?,
                document_type: text(r, "document_type")?,
                author: text(r, "author")?,
                verification: text(r, "verification")?,
                notes: text(r, "notes")?,
                project_id: text(r, "project_id")?,
                project_name: text(r, "project_name")?,
                created_at: read_ms(r, "created_at")?,
            }));
        }
    }
    let rows = tx.query(
        "SELECT id, project_id, source_file, source_sha256, location, theme, excerpt, action,
           status, reviewer, note, created_at, updated_at FROM document_review WHERE tenant_id = $1",
        &[&tenant],
    )?;
    if let Some(slot) = out.get_mut(table::REVIEWS) {
        for r in &rows {
            slot.push(fingerprint_review(&DocumentReview {
                id: text(r, "id")?,
                project_id: text(r, "project_id")?,
                source_file: text(r, "source_file")?,
                source_sha256: text(r, "source_sha256")?,
                location: text(r, "location")?,
                theme: text(r, "theme")?,
                excerpt: text(r, "excerpt")?,
                action: text(r, "action")?,
                status: text(r, "status")?,
                reviewer: text(r, "reviewer")?,
                note: text(r, "note")?,
                created_at: read_ms(r, "created_at")?,
                updated_at: read_ms(r, "updated_at")?,
            }));
        }
    }
    let rows = tx.query(
        "SELECT id, project_id, created_at, source_url, source_type, excerpt, sha256, level,
           score, method, themes::text AS themes, signals::text AS signals,
           suggestions::text AS suggestions, semantic_active, status, analyst_note,
           reviewer_note, reviewed_at FROM digital_alert_reviews WHERE tenant_id = $1",
        &[&tenant],
    )?;
    if let Some(slot) = out.get_mut(table::ALERTS) {
        for r in &rows {
            slot.push(fingerprint_alert(&Alert {
                id: text(r, "id")?,
                project_id: text(r, "project_id")?,
                created_at: read_ms(r, "created_at")?,
                source_url: text(r, "source_url")?,
                source_type: text(r, "source_type")?,
                excerpt: text(r, "excerpt")?,
                sha256: text(r, "sha256")?,
                level: text(r, "level")?,
                score: f64::from(r.try_get::<_, i32>("score")?),
                method: text(r, "method")?,
                themes: read_json(r, "themes")?,
                signals: read_json(r, "signals")?,
                suggestions: read_json(r, "suggestions")?,
                semantic_active: r.try_get("semantic_active")?,
                status: text(r, "status")?,
                analyst_note: text(r, "analyst_note")?,
                reviewer_note: maybe(r, "reviewer_note")?,
                reviewed_at: read_maybe_ms(r, "reviewed_at")?,
            }));
        }
    }
    let rows = tx.query(
        "SELECT id, project_id, alert_id, title, responsible, due_date, description, status,
           progress, created_at, updated_at FROM preventive_actions WHERE tenant_id = $1",
        &[&tenant],
    )?;
    if let Some(slot) = out.get_mut(table::ACTIONS) {
        for r in &rows {
            slot.push(fingerprint_action(&Action {
                id: text(r, "id")?,
                project_id: text(r, "project_id")?,
                alert_id: text(r, "alert_id")?,
                title: text(r, "title")?,
                responsible: text(r, "responsible")?,
                due_date: text(r, "due_date")?,
                description: text(r, "description")?,
                status: text(r, "status")?,
                progress: f64::from(r.try_get::<_, i32>("progress")?),
                created_at: read_ms(r, "created_at")?,
                updated_at: read_ms(r, "updated_at")?,
            }));
        }
    }
    let rows = tx.query(
        "SELECT id, action_id, created_at, status, progress, note, evidence_url
           FROM preventive_action_log WHERE tenant_id = $1",
        &[&tenant],
    )?;
    if let Some(slot) = out.get_mut(table::ACTION_LOG) {
        for r in &rows {
            slot.push(fingerprint_action_log(&ActionLog {
                id: text(r, "id")?,
                action_id: text(r, "action_id")?,
                created_at: read_ms(r, "created_at")?,
                status: text(r, "status")?,
                progress: f64::from(r.try_get::<_, i32>("progress")?),
                note: text(r, "note")?,
                evidence_url: maybe(r, "evidence_url")?,
            }));
        }
    }
    Ok(out)
}

/// The target database.
pub struct Store {
    client: Client,
    url: String,
    cipher: Cipher,
}

impl Store {
    /// A store over an open client.
    #[must_use]
    pub fn new(client: Client, url: String, cipher: Cipher) -> Self {
        Self {
            client,
            url,
            cipher,
        }
    }

    /// postgres.js opens a new connection after losing one, so a tenant that failed on a broken
    /// connection does not take the next ones with it.
    fn client(&mut self) -> Result<&mut Client, StoreError> {
        if self.client.is_closed() {
            self.client = db::connect(&self.url).map_err(StoreError::Connect)?;
        }
        Ok(&mut self.client)
    }

    /// `globalCounts`.
    ///
    /// # Errors
    /// Driver errors.
    pub fn global_counts(&mut self) -> Result<GlobalCounts, StoreError> {
        let client = self.client()?;
        let mut one = |table: &str| {
            let rows = client.query(&format!("SELECT count(*) AS n FROM {table}"), &[])?;
            count(rows.first())
        };
        Ok(GlobalCounts {
            users: one("users")?,
            tenants: one("tenants")?,
            grants: one("grants")?,
        })
    }

    /// `tenantCounts`.
    ///
    /// # Errors
    /// Driver errors.
    pub fn tenant_counts(&mut self, tenant: &str) -> Result<Counts, StoreError> {
        with_tenant(self.client()?, tenant, |tx| {
            let mut counts = [0; 9];
            for (slot, table) in counts.iter_mut().zip(TENANT_TABLES) {
                let rows = tx.query(
                    &format!("SELECT count(*) AS n FROM {table} WHERE tenant_id = $1"),
                    &[&tenant],
                )?;
                *slot = count(rows.first())?;
            }
            Ok(counts)
        })
    }

    /// `writeGlobal`: one transaction for tenants, users and grants.
    ///
    /// # Errors
    /// Driver errors, or a secret that could not be sealed; the transaction rolls back.
    pub fn write_global(
        &mut self,
        batch: GlobalBatch<'_>,
    ) -> Result<Written<GlobalCounts>, StoreError> {
        let mut sealed = Vec::with_capacity(batch.users.len());
        for user in batch.users {
            sealed.push(match &user.totp_secret {
                Some(secret) => Some(self.cipher.seal(secret).map_err(|_| StoreError::Seal)?),
                None => None,
            });
        }
        let mut tx = self.client()?.transaction()?;
        let mut skipped = Vec::new();
        let mut counts = GlobalCounts::default();
        for tenant in batch.tenants {
            let rows = tx.query(
                "INSERT INTO tenants (company_id, project_id, label) VALUES ($1, $2, $3)
                 ON CONFLICT DO NOTHING RETURNING tenant_id",
                &[&tenant.company, &tenant.project, &tenant.label],
            )?;
            counts.tenants += rows.len();
            if rows.is_empty() {
                skipped.push(Skipped {
                    table: "tenants".to_owned(),
                    id: tenant.tenant_id(),
                });
            }
        }
        for (user, seal) in batch.users.iter().zip(&sealed) {
            let enabled = user.totp_enabled && user.totp_secret.is_some();
            let rows = tx.query(
                "INSERT INTO users (username, full_name, password_hash, role, active, created_at,
                   totp_secret_sealed, totp_enabled)
                 VALUES ($1, $2, $3, $4, $5, $6::text::timestamptz, $7, $8)
                 ON CONFLICT (username) DO NOTHING RETURNING username",
                &[
                    &user.username,
                    &user.full_name,
                    &user.password_hash,
                    &user.role,
                    &user.active,
                    &iso(user.created_at),
                    seal,
                    &enabled,
                ],
            )?;
            counts.users += rows.len();
            if rows.is_empty() {
                skipped.push(Skipped {
                    table: "users".to_owned(),
                    id: user.username.clone(),
                });
            }
        }
        for grant in batch.grants {
            let rows = tx.query(
                "INSERT INTO grants (username, tenant_id) VALUES ($1, $2)
                 ON CONFLICT DO NOTHING RETURNING username",
                &[&grant.username, &grant.tenant_id],
            )?;
            counts.grants += rows.len();
            if rows.is_empty() {
                skipped.push(Skipped {
                    table: "grants".to_owned(),
                    id: format!("{}@{}", grant.username, grant.tenant_id),
                });
            }
        }
        tx.commit()?;
        Ok(Written { counts, skipped })
    }

    /// `writeTenant`: one tenant transaction, committed as a whole or not at all.
    ///
    /// # Errors
    /// Driver errors; the transaction rolls back.
    pub fn write_tenant(
        &mut self,
        tenant: &str,
        batch: &TenantBatch,
    ) -> Result<Written<Counts>, StoreError> {
        with_tenant(self.client()?, tenant, |tx| {
            let mut counts = [0; 9];
            let mut skipped = Vec::new();
            let mut tally = Tally {
                counts: &mut counts,
                skipped: &mut skipped,
            };
            write_records(tx, &batch.records, &mut tally)?;
            write_audit(tx, &batch.audit, &mut tally)?;
            if let Some(config) = &batch.irsa_config {
                let rows = tx.query(
                    "INSERT INTO irsa_configs (tenant_id, config) VALUES ($1, $2::text::json)
                     ON CONFLICT (tenant_id) DO NOTHING RETURNING tenant_id",
                    &[&tenant, &json::stringify(config)],
                )?;
                tally.bump(table::IRSA_CONFIGS, rows.len(), Some(tenant));
            }
            write_snapshots(tx, tenant, &batch.snapshots, &mut tally)?;
            write_attachments(tx, &batch.attachments, &mut tally)?;
            write_reviews(tx, &batch.document_reviews, &mut tally)?;
            write_alerts(tx, &batch.alerts, &mut tally)?;
            write_actions(tx, &batch.actions, &mut tally)?;
            write_action_log(tx, &batch.action_log, &mut tally)?;
            Ok(Written { counts, skipped })
        })
    }

    /// `identity`.
    ///
    /// # Errors
    /// Driver errors.
    pub fn identity(&mut self) -> Result<Identity, StoreError> {
        let client = self.client()?;
        let mut identity = Identity::default();
        for r in client.query(
            "SELECT username, full_name, password_hash, role, active, totp_enabled,
               totp_secret_sealed IS NOT NULL AS totp_present FROM users",
            &[],
        )? {
            identity.users.push(TargetUser {
                username: r.try_get("username")?,
                full_name: r.try_get("full_name")?,
                password_hash: r.try_get("password_hash")?,
                role: r.try_get("role")?,
                active: r.try_get("active")?,
                totp_enabled: r.try_get("totp_enabled")?,
                totp_present: r.try_get("totp_present")?,
            });
        }
        for r in client.query("SELECT company_id, project_id, label FROM tenants", &[])? {
            identity.tenants.push(Scope {
                company: r.try_get("company_id")?,
                project: r.try_get("project_id")?,
                label: r.try_get("label")?,
            });
        }
        for r in client.query("SELECT username, tenant_id FROM grants", &[])? {
            identity.grants.push(Grant {
                username: r.try_get("username")?,
                tenant_id: r.try_get("tenant_id")?,
            });
        }
        Ok(identity)
    }

    /// `rowFingerprints`.
    ///
    /// # Errors
    /// Driver errors or a stored JSON value that does not parse.
    pub fn row_fingerprints(&mut self, tenant: &str) -> Result<[Vec<String>; 9], StoreError> {
        with_tenant(self.client()?, tenant, |tx| fingerprints(tx, tenant))
    }

    /// `attachmentDigests`.
    ///
    /// # Errors
    /// Driver errors.
    pub fn attachment_digests(
        &mut self,
        tenant: &str,
    ) -> Result<Vec<AttachmentDigest>, StoreError> {
        with_tenant(self.client()?, tenant, |tx| {
            tx.query(
                "SELECT id, sha256, storage_key FROM attachments WHERE tenant_id = $1",
                &[&tenant],
            )?
            .iter()
            .map(|r| {
                Ok(AttachmentDigest {
                    id: r.try_get("id")?,
                    sha256: r.try_get("sha256")?,
                    storage_key: r.try_get("storage_key")?,
                })
            })
            .collect()
        })
    }
}
