//! `domain/mapping.ts`: the pure mapping from legacy rows to the PostgreSQL schema. Every
//! rejection is a problem code, so a report never touches record contents.

use std::fmt::Write as _;
use std::time::{Duration, UNIX_EPOCH};

use ring::digest::{SHA256, digest};
use sipges_tools_common::{js, time};

use crate::json::{self, Json, ParseError};
use crate::value::{
    Legacy, Row, as_number, as_text, boolean_or, parse_timestamp, parse_timestamp_text, text_or,
};

/// A problem code (`ProblemCode`).
pub type Code = &'static str;

/// A failure TypeScript does not catch: it ends the run with exit code 1.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Fatal {
    /// The JavaScript error name.
    pub name: &'static str,
    /// A fixed text or a path of the operator's; never a value of a record.
    pub message: Option<String>,
}

impl Fatal {
    /// An error reported by name only.
    #[must_use]
    pub const fn named(name: &'static str) -> Self {
        Self {
            name,
            message: None,
        }
    }
}

/// Why a mapper produced no row.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Reject {
    /// Reported as a problem; the run goes on.
    Code(Code),
    /// Ends the run.
    Fatal(Fatal),
}

impl From<Fatal> for Reject {
    fn from(fatal: Fatal) -> Self {
        Self::Fatal(fatal)
    }
}

/// A mapper's outcome.
pub type Mapped<T> = Result<T, Reject>;

const fn reject<T>(code: Code) -> Mapped<T> {
    Err(Reject::Code(code))
}

/// Milliseconds since the epoch: a `Date`.
pub type Ms = i64;

/// `date.toISOString()`; every `Ms` here passed `TimeClip`, so it always formats.
#[must_use]
pub fn iso(ms: Ms) -> String {
    let offset = Duration::from_millis(ms.unsigned_abs());
    let at = if ms < 0 {
        UNIX_EPOCH.checked_sub(offset)
    } else {
        UNIX_EPOCH.checked_add(offset)
    };
    at.and_then(time::to_iso_string).unwrap_or_default()
}

/// Nesting past which TypeScript's recursion may overflow the stack; `hasNul` is its first
/// recursive walk. The overflow point varies, so Rust stops at a fixed depth below it.
pub const MAX_JSON_DEPTH: usize = 1000;

const ROLES: [&str; 4] = ["admin", "analista", "coordinador", "consulta"];
const REVIEW_STATUSES: [&str; 4] = [
    "pendiente",
    "aceptado_para_revision",
    "descartado",
    "corroborado_documentalmente",
];
const ALERT_STATUSES: [&str; 4] = [
    "Pendiente de verificación",
    "Corroborado",
    "Descartado",
    "En seguimiento",
];
const ACTION_STATUSES: [&str; 4] = ["Pendiente", "En ejecución", "Completada", "Cancelada"];

/// `MODULES` of the records context, slug to stored name.
const MODULES: [(&str, &str); 21] = [
    ("eventos", "Eventos"),
    ("actores", "Actores"),
    ("demandas", "Demandas"),
    ("compromisos", "Compromisos"),
    ("narrativas", "Narrativas"),
    ("fuentes", "Fuentes"),
    ("indicadores", "Indicadores"),
    ("alertas", "Alertas"),
    ("acciones", "Acciones"),
    ("directorio", "Directorio_Territorial"),
    ("priorizados", "Actores_Priorizados"),
    ("usuarios", "Usuarios"),
    ("roles", "Roles"),
    ("proyectos", "Proyectos"),
    ("intereses", "Intereses"),
    ("dialogos", "Dialogos"),
    ("oportunidades", "Oportunidades"),
    ("hechos", "Hechos_Compartidos"),
    ("aarc", "Evaluaciones_AARC"),
    ("buzon", "Buzon"),
    ("lecciones", "Lecciones_Territoriales"),
];

fn module_for_slug(slug: &str) -> Option<&'static str> {
    MODULES
        .iter()
        .find(|(known, _)| *known == slug)
        .map(|(_, module)| *module)
}

/// `/^[0-9a-f]{64}$/`.
fn is_sha256(text: &str) -> bool {
    text.len() == 64 && text.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// `/^\d{4}-\d{2}-\d{2}$/`.
fn is_date_only(text: &str) -> bool {
    text.len() == 10
        && text.bytes().enumerate().all(|(i, b)| {
            if i == 4 || i == 7 {
                b == b'-'
            } else {
                b.is_ascii_digit()
            }
        })
}

fn is_safe_object_char(b: u8) -> bool {
    b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-')
}

/// `/^pbkdf2_sha256\$\d{1,7}\$[0-9a-f]+\$[0-9a-f]+$/`.
fn is_legacy_hash(text: &str) -> bool {
    let hex = |s: &str| !s.is_empty() && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'));
    let mut parts = text.split('$');
    parts.next() == Some("pbkdf2_sha256")
        && parts
            .next()
            .is_some_and(|n| (1..=7).contains(&n.len()) && n.bytes().all(|b| b.is_ascii_digit()))
        && parts.next().is_some_and(hex)
        && parts.next().is_some_and(hex)
        && parts.next().is_none()
}

fn storable(text: &str) -> bool {
    !text.contains('\0')
}

fn all_storable(values: &[Option<&str>]) -> bool {
    values.iter().flatten().all(|text| storable(text))
}

/// `Number.isInteger(x) && 0 <= x <= 100`.
fn is_progress(x: f64) -> bool {
    x.fract() == 0.0 && (0.0..=100.0).contains(&x)
}

/// `parseJsonObject`: `hasNul` runs outside its `try`, so too much depth ends the run.
fn parse_json_object(value: &Legacy) -> Result<Option<Json>, Fatal> {
    let Some(text) = as_text(value) else {
        return Ok(None);
    };
    match json::parse(&text) {
        Err(ParseError::Syntax) => Ok(None),
        Err(ParseError::TooDeep) => Err(Fatal::named("RangeError")),
        Ok(parsed) if parsed.depth > MAX_JSON_DEPTH => Err(Fatal::named("RangeError")),
        Ok(parsed) => match parsed.value {
            object @ Json::Obj(_) if !json::has_nul(&object) => Ok(Some(object)),
            _ => Ok(None),
        },
    }
}

/// `parseJsonStrict`: `hasNul` runs inside its `try`, so too much depth is just unreadable.
fn parse_json_strict(value: &Legacy) -> Option<Json> {
    let parsed = json::parse(&as_text(value)?).ok()?;
    (parsed.depth <= MAX_JSON_DEPTH && !json::has_nul(&parsed.value)).then_some(parsed.value)
}

/// `formatTenantId`.
#[must_use]
pub fn format_tenant_id(company: &str, project: &str) -> String {
    format!("{company}/{project}")
}

/// `sha256Hex`.
#[must_use]
pub fn sha256_hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(64);
    for byte in digest(&SHA256, bytes).as_ref() {
        let _ = write!(out, "{byte:02x}");
    }
    out
}

/// `scopeDigest`: app.py names a non-default scope's directory with this.
#[must_use]
pub fn scope_digest(tenant: &str) -> String {
    let mut hex = sha256_hex(tenant.as_bytes());
    hex.truncate(24);
    hex
}

/// `legacyStoredNameSafe`.
#[must_use]
pub fn stored_name_safe(name: &str) -> bool {
    !name.is_empty()
        && !name.contains(['/', '\\'])
        && storable(name)
        && !name.contains("..")
        && name != "."
}

/// `objectKeyFor`: the key, and whether the legacy name had to be replaced.
#[must_use]
pub fn object_key_for(tenant: &str, stored_name: &str) -> (String, bool) {
    let prefix = scope_digest(tenant);
    if !stored_name.is_empty()
        && stored_name.bytes().all(is_safe_object_char)
        && js::utf16_len(stored_name) <= 180
    {
        return (format!("{prefix}/{stored_name}"), false);
    }
    let mut name_digest = sha256_hex(stored_name.as_bytes());
    name_digest.truncate(32);
    // .replace(/[^A-Za-z0-9._-]+/g, '-')
    let mut tail = String::new();
    let mut in_run = false;
    for c in stored_name.chars() {
        if c.is_ascii() && is_safe_object_char(u8::try_from(c).unwrap_or(0)) {
            tail.push(c);
            in_run = false;
        } else if !in_run {
            tail.push('-');
            in_run = true;
        }
    }
    // .replace(/^[-.]+/, '').slice(0, 60): only ASCII is left.
    let trimmed = tail.trim_start_matches(['-', '.']);
    let tail = trimmed.get(..60).unwrap_or(trimmed);
    let tail = if tail.is_empty() { "archivo" } else { tail };
    (format!("{prefix}/{name_digest}_{tail}"), true)
}

/// A `tenant_projects` row, already through `String(x ?? '')`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Scope {
    /// `company_id`.
    pub company: String,
    /// `project_id`.
    pub project: String,
    /// `label`.
    pub label: String,
}

impl Scope {
    /// `mapTenant`'s test: ids present, everything storable.
    #[must_use]
    pub fn is_valid(&self) -> bool {
        !self.company.is_empty()
            && !self.project.is_empty()
            && storable(&self.company)
            && storable(&self.project)
            && storable(&self.label)
    }

    /// `company/project`.
    #[must_use]
    pub fn tenant_id(&self) -> String {
        format_tenant_id(&self.company, &self.project)
    }
}

/// `TargetUser`.
#[derive(Clone, Debug)]
pub struct User {
    /// Trimmed account name.
    pub username: String,
    /// Display name.
    pub full_name: String,
    /// Legacy PBKDF2 hash.
    pub password_hash: String,
    /// Role.
    pub role: String,
    /// Whether the account can sign in.
    pub active: bool,
    /// Creation time.
    pub created_at: Ms,
    /// Plaintext legacy secret, sealed by the writer.
    pub totp_secret: Option<String>,
    /// Whether TOTP was on.
    pub totp_enabled: bool,
}

/// `mapUser`.
///
/// # Errors
/// The problem code of the first failed check.
pub fn map_user(row: &Row) -> Mapped<User> {
    let username = as_text(row.get("username"))
        .map(|text| js::trim(&text).to_owned())
        .unwrap_or_default();
    if username.is_empty() || js::utf16_len(&username) > 120 || !storable(&username) {
        return reject("user_username_invalid");
    }
    let Some(full_name) = as_text(row.get("full_name")).filter(|name| storable(name)) else {
        return reject("user_full_name_invalid");
    };
    let password_hash = text_or(row.get("password_hash"), "");
    if !is_legacy_hash(&password_hash) {
        return reject("user_password_hash_invalid");
    }
    let role = text_or(row.get("role"), "");
    if !ROLES.contains(&role.as_str()) {
        return reject("user_role_invalid");
    }
    let Some(created_at) = parse_timestamp(row.get("created_at")) else {
        return reject("user_created_at_invalid");
    };
    Ok(User {
        username,
        full_name,
        password_hash,
        role,
        active: boolean_or(row.get("active"), true),
        created_at,
        totp_secret: as_text(row.get("totp_secret")).filter(|secret| !secret.is_empty()),
        totp_enabled: boolean_or(row.get("totp_enabled"), false),
    })
}

/// `TargetRecord`.
#[derive(Clone, Debug)]
pub struct Record {
    /// Stored module name.
    pub module: String,
    /// Record id.
    pub id: String,
    /// The JSON object.
    pub payload: Json,
    /// Creation time.
    pub created_at: Ms,
    /// Update time.
    pub updated_at: Ms,
}

/// `mapRecord`.
///
/// # Errors
/// The problem code, or a payload nested too deep.
pub fn map_record(row: &Row) -> Mapped<Record> {
    let module = text_or(row.get("module"), "");
    let id = text_or(row.get("record_id"), "");
    if module.is_empty()
        || id.is_empty()
        || js::utf16_len(&id) > 200
        || !storable(&module)
        || !storable(&id)
    {
        return reject("record_key_invalid");
    }
    let Some(payload) = parse_json_object(row.get("payload"))? else {
        return reject("record_payload_invalid");
    };
    let (Some(created_at), Some(updated_at)) = (
        parse_timestamp(row.get("created_at")),
        parse_timestamp(row.get("updated_at")),
    ) else {
        return reject("record_timestamp_invalid");
    };
    Ok(Record {
        module,
        id,
        payload,
        created_at,
        updated_at,
    })
}

/// `TargetAudit`.
#[derive(Clone, Debug)]
pub struct Audit {
    /// Event time.
    pub ts: Ms,
    /// Module.
    pub module: String,
    /// Record id.
    pub record_id: Option<String>,
    /// Action.
    pub action: String,
    /// Detail.
    pub detail: Option<String>,
}

/// `mapAudit`.
///
/// # Errors
/// `audit_row_invalid`.
pub fn map_audit(row: &Row) -> Mapped<Audit> {
    let (Some(ts), Some(module), Some(action)) = (
        parse_timestamp(row.get("ts")),
        as_text(row.get("module")),
        as_text(row.get("action")),
    ) else {
        return reject("audit_row_invalid");
    };
    let record_id = as_text(row.get("record_id"));
    let detail = as_text(row.get("detail"));
    if !all_storable(&[
        Some(&module),
        Some(&action),
        record_id.as_deref(),
        detail.as_deref(),
    ]) {
        return reject("audit_row_invalid");
    }
    Ok(Audit {
        ts,
        module,
        record_id,
        action,
        detail,
    })
}

/// `TargetSnapshot`.
#[derive(Clone, Debug)]
pub struct Snapshot {
    /// Event time.
    pub ts: Ms,
    /// IRSA value.
    pub irsa: f64,
    /// Level.
    pub level: String,
    /// Scores object.
    pub scores: Json,
    /// Configuration version.
    pub config_version: Option<String>,
    /// Note.
    pub note: Option<String>,
}

/// `mapSnapshot`: every field is read before any check.
///
/// # Errors
/// `snapshot_row_invalid`, or scores nested too deep.
pub fn map_snapshot(row: &Row) -> Mapped<Snapshot> {
    let ts = parse_timestamp(row.get("ts"));
    let irsa = as_number(row.get("irsa"));
    let level = as_text(row.get("level"));
    let scores = parse_json_object(row.get("scores"))?;
    let config_version = as_text(row.get("config_version"));
    let note = as_text(row.get("note"));
    let (Some(ts), Some(irsa), Some(level), Some(scores)) = (ts, irsa, level, scores) else {
        return reject("snapshot_row_invalid");
    };
    if !all_storable(&[Some(&level), config_version.as_deref(), note.as_deref()]) {
        return reject("snapshot_row_invalid");
    }
    Ok(Snapshot {
        ts,
        irsa,
        level,
        scores,
        config_version,
        note,
    })
}

/// `TargetAttachment`.
#[derive(Clone, Debug)]
pub struct Attachment {
    /// Attachment id.
    pub id: String,
    /// Object storage key.
    pub storage_key: String,
    /// Legacy file name.
    pub legacy_stored_name: String,
    /// Name the user uploaded.
    pub original_name: String,
    /// Content type.
    pub content_type: String,
    /// Size in bytes.
    pub size_bytes: f64,
    /// Digest; `None` before the bytes are read when the legacy value is unusable.
    pub sha256: Option<String>,
    /// Legacy slug.
    pub linked_module: String,
    /// Stored module name.
    pub record_module: String,
    /// Linked record.
    pub linked_record_id: String,
    /// Document type.
    pub document_type: String,
    /// Author.
    pub author: String,
    /// Verification level.
    pub verification: String,
    /// Notes.
    pub notes: String,
    /// Project id.
    pub project_id: String,
    /// Project name.
    pub project_name: String,
    /// Creation time.
    pub created_at: Ms,
}

/// `mapAttachment`.
///
/// # Errors
/// The problem code of the first failed check.
pub fn map_attachment(row: &Row, tenant: &str) -> Mapped<Attachment> {
    let id = text_or(row.get("id"), "");
    let stored_name = text_or(row.get("stored_name"), "");
    let linked_record_id = text_or(row.get("linked_record_id"), "");
    let size_bytes = as_number(row.get("size_bytes")).unwrap_or(0.0);
    let created_at = parse_timestamp(row.get("created_at"));
    let Some(created_at) = created_at.filter(|_| {
        !id.is_empty() && !stored_name.is_empty() && !linked_record_id.is_empty() && storable(&id)
    }) else {
        return reject("attachment_row_invalid");
    };
    if size_bytes.fract() != 0.0 || size_bytes <= 0.0 {
        return reject("attachment_row_invalid");
    }
    if !stored_name_safe(&stored_name) {
        return reject("attachment_stored_name_unsafe");
    }
    let linked_module = js::trim(&text_or(row.get("linked_module"), "")).to_lowercase();
    let Some(record_module) = module_for_slug(&linked_module) else {
        return reject("attachment_module_unknown");
    };
    let project_id = text_or(row.get("project_id"), "PRJ-SECHURA");
    let default_name = if project_id == "PRJ-SECHURA" {
        "Proyecto Sechura"
    } else {
        ""
    };
    let attachment = Attachment {
        id,
        storage_key: object_key_for(tenant, &stored_name).0,
        original_name: text_or(row.get("original_name"), &stored_name),
        legacy_stored_name: stored_name,
        content_type: text_or(row.get("content_type"), "application/octet-stream"),
        size_bytes,
        sha256: as_text(row.get("sha256")).filter(|sha| is_sha256(sha)),
        linked_module,
        record_module: record_module.to_owned(),
        linked_record_id,
        document_type: text_or(row.get("document_type"), ""),
        author: text_or(row.get("author"), ""),
        verification: text_or(row.get("verification"), ""),
        notes: text_or(row.get("notes"), ""),
        project_name: text_or(row.get("project_name"), default_name),
        project_id,
        created_at,
    };
    let texts = [
        &attachment.linked_module,
        &attachment.linked_record_id,
        &attachment.original_name,
        &attachment.content_type,
        &attachment.document_type,
        &attachment.author,
        &attachment.verification,
        &attachment.notes,
        &attachment.project_id,
        &attachment.project_name,
    ];
    if texts.iter().all(|text| storable(text)) {
        Ok(attachment)
    } else {
        reject("attachment_row_invalid")
    }
}

/// `TargetDocumentReview`.
#[derive(Clone, Debug)]
pub struct DocumentReview {
    /// Review id.
    pub id: String,
    /// Project id.
    pub project_id: String,
    /// Source file.
    pub source_file: String,
    /// Source digest.
    pub source_sha256: String,
    /// Location in the source.
    pub location: String,
    /// Theme.
    pub theme: String,
    /// Excerpt.
    pub excerpt: String,
    /// Action.
    pub action: String,
    /// Status.
    pub status: String,
    /// Reviewer.
    pub reviewer: String,
    /// Note.
    pub note: String,
    /// Creation time.
    pub created_at: Ms,
    /// Update time.
    pub updated_at: Ms,
}

/// `mapDocumentReview`.
///
/// # Errors
/// `document_review_row_invalid`.
pub fn map_document_review(row: &Row) -> Mapped<DocumentReview> {
    let id = text_or(row.get("id"), "");
    let status = text_or(row.get("status"), "");
    let source_sha256 = text_or(row.get("source_sha256"), "");
    let (Some(created_at), Some(updated_at)) = (
        parse_timestamp(row.get("created_at")),
        parse_timestamp(row.get("updated_at")),
    ) else {
        return reject("document_review_row_invalid");
    };
    if id.is_empty() || !is_sha256(&source_sha256) || !REVIEW_STATUSES.contains(&status.as_str()) {
        return reject("document_review_row_invalid");
    }
    let review = DocumentReview {
        id,
        project_id: text_or(row.get("project_id"), "PRJ-SECHURA"),
        source_file: text_or(row.get("source_file"), ""),
        source_sha256,
        location: text_or(row.get("location"), ""),
        theme: text_or(row.get("theme"), ""),
        excerpt: text_or(row.get("excerpt"), ""),
        action: text_or(row.get("action"), ""),
        status,
        reviewer: text_or(row.get("reviewer"), ""),
        note: text_or(row.get("note"), ""),
        created_at,
        updated_at,
    };
    let texts = [
        &review.id,
        &review.project_id,
        &review.source_file,
        &review.location,
        &review.theme,
        &review.excerpt,
        &review.action,
        &review.reviewer,
        &review.note,
    ];
    if texts.iter().all(|text| storable(text)) {
        Ok(review)
    } else {
        reject("document_review_row_invalid")
    }
}

/// `TargetAlert`.
#[derive(Clone, Debug)]
pub struct Alert {
    /// Alert id.
    pub id: String,
    /// Project id.
    pub project_id: String,
    /// Creation time.
    pub created_at: Ms,
    /// Source URL.
    pub source_url: String,
    /// Source type.
    pub source_type: String,
    /// Excerpt.
    pub excerpt: String,
    /// Text digest.
    pub sha256: String,
    /// Level.
    pub level: String,
    /// Score, truncated.
    pub score: f64,
    /// Method.
    pub method: String,
    /// Themes.
    pub themes: Json,
    /// Signals.
    pub signals: Json,
    /// Suggestions.
    pub suggestions: Json,
    /// Whether semantic analysis ran.
    pub semantic_active: bool,
    /// Status.
    pub status: String,
    /// Analyst note.
    pub analyst_note: String,
    /// Reviewer note.
    pub reviewer_note: Option<String>,
    /// Review time.
    pub reviewed_at: Option<Ms>,
}

/// `mapAlert`.
///
/// # Errors
/// `alert_row_invalid`.
pub fn map_alert(row: &Row) -> Mapped<Alert> {
    let invalid = "alert_row_invalid";
    let id = text_or(row.get("id"), "");
    let created_at = parse_timestamp(row.get("created_at"));
    let status = text_or(row.get("status"), "");
    let sha256 = text_or(row.get("sha256"), "");
    let score = as_number(row.get("score")).unwrap_or(0.0);
    let Some(created_at) = created_at else {
        return reject(invalid);
    };
    if id.is_empty() || !is_sha256(&sha256) || !ALERT_STATUSES.contains(&status.as_str()) {
        return reject(invalid);
    }
    let (Some(themes), Some(signals), Some(suggestions)) = (
        parse_json_strict(row.get("themes_json")),
        parse_json_strict(row.get("signals_json")),
        parse_json_strict(row.get("suggestions_json")),
    ) else {
        return reject(invalid);
    };
    let reviewed = as_text(row.get("reviewed_at"))
        .map(|text| js::trim(&text).to_owned())
        .unwrap_or_default();
    let reviewed_at = if reviewed.is_empty() {
        None
    } else {
        let Some(at) = parse_timestamp_text(&reviewed) else {
            return reject(invalid);
        };
        Some(at)
    };
    let alert = Alert {
        id,
        project_id: text_or(row.get("project_id"), "PRJ-SECHURA"),
        created_at,
        source_url: text_or(row.get("source_url"), ""),
        source_type: text_or(row.get("source_type"), ""),
        excerpt: text_or(row.get("excerpt"), ""),
        sha256,
        level: text_or(row.get("level"), ""),
        score: score.trunc(),
        method: text_or(row.get("method"), ""),
        themes,
        signals,
        suggestions,
        semantic_active: boolean_or(row.get("semantic_active"), false),
        status,
        analyst_note: text_or(row.get("analyst_note"), ""),
        reviewer_note: as_text(row.get("reviewer_note")),
        reviewed_at,
    };
    if all_storable(&[
        Some(&alert.id),
        Some(&alert.project_id),
        Some(&alert.source_url),
        Some(&alert.source_type),
        Some(&alert.excerpt),
        Some(&alert.level),
        Some(&alert.method),
        Some(&alert.analyst_note),
        alert.reviewer_note.as_deref(),
    ]) {
        Ok(alert)
    } else {
        reject(invalid)
    }
}

/// `TargetAction`.
#[derive(Clone, Debug)]
pub struct Action {
    /// Action id.
    pub id: String,
    /// Project id.
    pub project_id: String,
    /// Alert it answers.
    pub alert_id: String,
    /// Title.
    pub title: String,
    /// Responsible.
    pub responsible: String,
    /// Due date, `YYYY-MM-DD`.
    pub due_date: String,
    /// Description.
    pub description: String,
    /// Status.
    pub status: String,
    /// Progress, 0 to 100.
    pub progress: f64,
    /// Creation time.
    pub created_at: Ms,
    /// Update time.
    pub updated_at: Ms,
}

/// `mapAction`.
///
/// # Errors
/// `action_row_invalid`.
pub fn map_action(row: &Row) -> Mapped<Action> {
    let invalid = "action_row_invalid";
    let id = text_or(row.get("id"), "");
    let alert_id = text_or(row.get("alert_id"), "");
    let due_date = text_or(row.get("due_date"), "");
    let status = text_or(row.get("status"), "");
    let progress = as_number(row.get("progress")).unwrap_or(0.0);
    let (Some(created_at), Some(updated_at)) = (
        parse_timestamp(row.get("created_at")),
        parse_timestamp(row.get("updated_at")),
    ) else {
        return reject(invalid);
    };
    if id.is_empty()
        || alert_id.is_empty()
        || !is_date_only(&due_date)
        || !ACTION_STATUSES.contains(&status.as_str())
        || !is_progress(progress)
    {
        return reject(invalid);
    }
    let action = Action {
        id,
        project_id: text_or(row.get("project_id"), "PRJ-SECHURA"),
        alert_id,
        title: text_or(row.get("title"), ""),
        responsible: text_or(row.get("responsible"), ""),
        due_date,
        description: text_or(row.get("description"), ""),
        status,
        progress,
        created_at,
        updated_at,
    };
    let texts = [
        &action.id,
        &action.project_id,
        &action.alert_id,
        &action.title,
        &action.responsible,
        &action.description,
    ];
    if texts.iter().all(|text| storable(text)) {
        Ok(action)
    } else {
        reject(invalid)
    }
}

/// `TargetActionLog`.
#[derive(Clone, Debug)]
pub struct ActionLog {
    /// Entry id.
    pub id: String,
    /// Action it belongs to.
    pub action_id: String,
    /// Creation time.
    pub created_at: Ms,
    /// Status.
    pub status: String,
    /// Progress, 0 to 100.
    pub progress: f64,
    /// Note.
    pub note: String,
    /// Evidence URL.
    pub evidence_url: Option<String>,
}

/// `mapActionLog`.
///
/// # Errors
/// `action_log_row_invalid`.
pub fn map_action_log(row: &Row) -> Mapped<ActionLog> {
    let invalid = "action_log_row_invalid";
    let id = text_or(row.get("id"), "");
    let action_id = text_or(row.get("action_id"), "");
    let created_at = parse_timestamp(row.get("created_at"));
    let progress = as_number(row.get("progress")).unwrap_or(0.0);
    let status = text_or(row.get("status"), "");
    let Some(created_at) = created_at else {
        return reject(invalid);
    };
    if id.is_empty() || action_id.is_empty() || status.is_empty() || !is_progress(progress) {
        return reject(invalid);
    }
    let note = text_or(row.get("note"), "");
    let evidence_url = as_text(row.get("evidence_url"));
    if !all_storable(&[
        Some(&id),
        Some(&action_id),
        Some(&status),
        Some(&note),
        evidence_url.as_deref(),
    ]) {
        return reject(invalid);
    }
    Ok(ActionLog {
        id,
        action_id,
        created_at,
        status,
        progress,
        note,
        evidence_url,
    })
}

/// `setChecksum`: each row hashed, the digests sorted and hashed together.
#[must_use]
pub fn set_checksum(rows: &[String]) -> String {
    let mut digests: Vec<String> = rows.iter().map(|row| sha256_hex(row.as_bytes())).collect();
    digests.sort();
    sha256_hex(digests.concat().as_bytes())
}

fn text(value: &str) -> Json {
    Json::text(value)
}

fn when(value: Ms) -> Json {
    Json::text(&iso(value))
}

fn maybe_when(value: Option<Ms>) -> Json {
    value.map_or(Json::Null, when)
}

fn row(values: Vec<Json>) -> String {
    json::canonical(&Json::Arr(values))
}

/// `rowFingerprint.module_records`.
#[must_use]
pub fn fingerprint_record(r: &Record) -> String {
    let first = format!(
        "{}\u{1}{}\u{1}{}",
        r.module,
        r.id,
        json::canonical(&r.payload)
    );
    row(vec![text(&first), when(r.created_at), when(r.updated_at)])
}

/// `rowFingerprint.audit`.
#[must_use]
pub fn fingerprint_audit(a: &Audit) -> String {
    row(vec![
        when(a.ts),
        text(&a.module),
        Json::optional(a.record_id.as_deref()),
        text(&a.action),
        Json::optional(a.detail.as_deref()),
    ])
}

/// `rowFingerprint.irsa_snapshots`.
#[must_use]
pub fn fingerprint_snapshot(s: &Snapshot) -> String {
    row(vec![
        when(s.ts),
        Json::Num(s.irsa),
        text(&s.level),
        s.scores.clone(),
        Json::optional(s.config_version.as_deref()),
        Json::optional(s.note.as_deref()),
    ])
}

/// `rowFingerprint.attachments`.
#[must_use]
pub fn fingerprint_attachment(a: &Attachment) -> String {
    row(vec![
        text(&a.id),
        text(&a.storage_key),
        text(&a.original_name),
        text(&a.content_type),
        Json::Num(a.size_bytes),
        Json::optional(a.sha256.as_deref()),
        text(&a.linked_module),
        text(&a.record_module),
        text(&a.linked_record_id),
        text(&a.document_type),
        text(&a.author),
        text(&a.verification),
        text(&a.notes),
        text(&a.project_id),
        text(&a.project_name),
        when(a.created_at),
    ])
}

/// `rowFingerprint.document_review`.
#[must_use]
pub fn fingerprint_review(r: &DocumentReview) -> String {
    row(vec![
        text(&r.id),
        text(&r.project_id),
        text(&r.source_file),
        text(&r.source_sha256),
        text(&r.location),
        text(&r.theme),
        text(&r.excerpt),
        text(&r.action),
        text(&r.status),
        text(&r.reviewer),
        text(&r.note),
        when(r.created_at),
        when(r.updated_at),
    ])
}

/// `rowFingerprint.digital_alert_reviews`.
#[must_use]
pub fn fingerprint_alert(a: &Alert) -> String {
    row(vec![
        text(&a.id),
        text(&a.project_id),
        when(a.created_at),
        text(&a.source_url),
        text(&a.source_type),
        text(&a.excerpt),
        text(&a.sha256),
        text(&a.level),
        Json::Num(a.score),
        text(&a.method),
        a.themes.clone(),
        a.signals.clone(),
        a.suggestions.clone(),
        Json::Bool(a.semantic_active),
        text(&a.status),
        text(&a.analyst_note),
        Json::optional(a.reviewer_note.as_deref()),
        maybe_when(a.reviewed_at),
    ])
}

/// `rowFingerprint.preventive_actions`.
#[must_use]
pub fn fingerprint_action(a: &Action) -> String {
    row(vec![
        text(&a.id),
        text(&a.project_id),
        text(&a.alert_id),
        text(&a.title),
        text(&a.responsible),
        text(&a.due_date),
        text(&a.description),
        text(&a.status),
        Json::Num(a.progress),
        when(a.created_at),
        when(a.updated_at),
    ])
}

/// `rowFingerprint.preventive_action_log`.
#[must_use]
pub fn fingerprint_action_log(l: &ActionLog) -> String {
    row(vec![
        text(&l.id),
        text(&l.action_id),
        when(l.created_at),
        text(&l.status),
        Json::Num(l.progress),
        text(&l.note),
        Json::optional(l.evidence_url.as_deref()),
    ])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make(columns: &[(&str, Legacy)]) -> Row {
        let names: Vec<String> = columns.iter().map(|(name, _)| (*name).to_owned()).collect();
        let values = columns.iter().map(|(_, value)| value.clone()).collect();
        Row::new(names.into(), values)
    }

    fn s(value: &str) -> Legacy {
        Legacy::Text(value.to_owned())
    }

    fn user(overrides: &[(&str, Legacy)]) -> Row {
        let hash = format!("pbkdf2_sha256$310000${}${}", "a".repeat(8), "b".repeat(8));
        let mut columns = vec![
            ("username", s("  ana ")),
            ("full_name", s("Ana")),
            ("password_hash", s(&hash)),
            ("role", s("admin")),
            ("created_at", s("2026-10-01T09:00:00")),
        ];
        for (name, value) in overrides {
            columns.retain(|(known, _)| known != name);
            columns.push((name, value.clone()));
        }
        make(&columns)
    }

    #[allow(clippy::needless_pass_by_value)]
    fn code<T>(outcome: Mapped<T>) -> Option<Code> {
        match outcome {
            Err(Reject::Code(code)) => Some(code),
            _ => None,
        }
    }

    #[test]
    fn maps_users_with_defaults() {
        let mapped = map_user(&user(&[]));
        assert!(
            mapped
                .as_ref()
                .is_ok_and(|u| u.username == "ana" && u.active)
        );
        assert!(mapped.is_ok_and(|u| !u.totp_enabled && u.totp_secret.is_none()));
        let empty = map_user(&user(&[("totp_secret", s(""))]));
        assert!(empty.is_ok_and(|u| u.totp_secret.is_none()));
    }

    #[test]
    fn refuses_users_in_order() {
        for (column, value, expected) in [
            ("username", s("  "), "user_username_invalid"),
            ("username", s(&"😀".repeat(61)), "user_username_invalid"),
            ("full_name", s("a\0"), "user_full_name_invalid"),
            (
                "password_hash",
                s("md5$1$a$b"),
                "user_password_hash_invalid",
            ),
            ("role", s("root"), "user_role_invalid"),
            ("created_at", s("ayer"), "user_created_at_invalid"),
        ] {
            assert_eq!(code(map_user(&user(&[(column, value)]))), Some(expected));
        }
    }

    #[test]
    fn recognises_the_legacy_hash_shape() {
        assert!(is_legacy_hash("pbkdf2_sha256$1$ab$cd"));
        for bad in [
            "pbkdf2_sha256$12345678$ab$cd",
            "pbkdf2_sha256$1$AB$cd",
            "pbkdf2_sha256$1$ab$cd$ef",
            "pbkdf2_sha256$1$$cd",
            "pbkdf2_sha256$1$ab$cd\n",
        ] {
            assert!(!is_legacy_hash(bad), "{bad}");
        }
    }

    #[test]
    fn keys_objects_like_object_key_for() {
        // Observed with Node: objectKeyFor('A/B', name).
        let prefix = scope_digest("A/B");
        assert_eq!(
            object_key_for("A/B", "abc_a.txt"),
            (format!("{prefix}/abc_a.txt"), false)
        );
        let (key, sanitized) = object_key_for("A/B", "--a b ñ😀.txt");
        assert!(sanitized);
        assert!(key.ends_with("_a-b-.txt"), "{key}");
        assert!(object_key_for("A/B", "ñ").0.ends_with("_archivo"));
        let long = "L".repeat(181);
        let (key, sanitized) = object_key_for("A/B", &long);
        assert!(sanitized);
        assert!(key.ends_with(&format!("_{}", "L".repeat(60))));
    }

    #[test]
    fn refuses_unsafe_stored_names() {
        for name in ["", "a/b", "a\\b", "a..b", ".", "a\0"] {
            assert!(!stored_name_safe(name), "{name:?}");
        }
        assert!(stored_name_safe("uuid_nombre con espacio.txt"));
    }

    #[test]
    fn checksums_are_order_independent() {
        let forward = set_checksum(&["a".to_owned(), "b".to_owned()]);
        let backward = set_checksum(&["b".to_owned(), "a".to_owned()]);
        assert_eq!(forward, backward);
        // Observed with Node: setChecksum([]).
        assert_eq!(
            set_checksum(&[]),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    #[test]
    fn fatal_depth_is_only_fatal_outside_the_strict_parser() {
        let deep = format!("{{\"x\":{}1{}}}", "[".repeat(1001), "]".repeat(1001));
        assert_eq!(
            parse_json_object(&s(&deep)),
            Err(Fatal::named("RangeError"))
        );
        assert_eq!(parse_json_strict(&s(&deep)), None);
    }
}
