//! SQL of `sql-review-store.ts` (`approved`) and `sql-record-store.ts` (`existing`, `create`,
//! `importBatch` in insert-only mode), each call in its own tenant transaction.

use std::collections::HashSet;
use std::time::SystemTime;

use postgres::Client;
use serde_json::{Map, Value};
use sipges_tools_common::tenant::{append_audit, with_tenant};

use crate::records::Fields;
use crate::review::{APPROVAL_STATUSES, ReviewItem};
use crate::run::Failure;

/// Records per insert statement (`IMPORT_CHUNK`).
const IMPORT_CHUNK: usize = 500;

/// Fields as the JSON object `JSON.stringify(payload)` writes.
#[must_use]
pub fn payload_json(fields: &Fields) -> Value {
    let mut map = Map::new();
    for (key, value) in fields {
        map.insert(key.clone(), Value::String(value.clone()));
    }
    Value::Object(map)
}

/// `ReviewStore.approved`: one page of approved items after `after_id`, by id.
///
/// # Errors
/// Driver errors.
pub fn approved(
    client: &mut Client,
    tenant: &str,
    after_id: &str,
    limit: i64,
) -> Result<Vec<ReviewItem>, Failure> {
    with_tenant(client, tenant, |tx| {
        let statuses: Vec<&str> = APPROVAL_STATUSES.to_vec();
        let rows = tx.query(
            "SELECT id, project_id, source_file, source_sha256, location, theme, excerpt, action,
  status, reviewer, note, created_at, updated_at FROM document_review
            WHERE status = ANY($3::text[]) AND id > $1
            ORDER BY id LIMIT $2",
            &[&after_id, &limit, &statuses],
        )?;
        rows.iter()
            .map(|row| {
                Ok(ReviewItem {
                    id: row.try_get("id")?,
                    source_file: row.try_get("source_file")?,
                    source_sha256: row.try_get("source_sha256")?,
                    location: row.try_get("location")?,
                    theme: row.try_get("theme")?,
                    excerpt: row.try_get("excerpt")?,
                    action: row.try_get("action")?,
                    status: row.try_get("status")?,
                    reviewer: row.try_get("reviewer")?,
                    note: row.try_get("note")?,
                    updated_at: sipges_tools_common::time::truncate_ms(row.try_get("updated_at")?),
                })
            })
            .collect()
    })
}

/// `RecordStore.existing`.
///
/// # Errors
/// Driver errors.
pub fn existing(
    client: &mut Client,
    tenant: &str,
    module: &str,
    ids: &[&str],
) -> Result<HashSet<String>, Failure> {
    with_tenant(client, tenant, |tx| {
        let rows = tx.query(
            "SELECT id FROM module_records WHERE module = $1 AND id = ANY($2::text[])",
            &[&module, &ids],
        )?;
        rows.iter()
            .map(|row| row.try_get::<_, String>(0).map_err(Failure::from))
            .collect()
    })
}

/// An audit note.
pub struct Note<'a> {
    /// `CREATE` or `IMPORT`.
    pub action: &'a str,
    /// Spanish detail.
    pub detail: &'a str,
}

/// `RecordStore.create` with one candidate id: inserts unless the id exists; audits the insert.
///
/// # Errors
/// Driver errors.
pub fn create(
    client: &mut Client,
    tenant: &str,
    module: &str,
    id: &str,
    payload: &Fields,
    note: &Note<'_>,
    at: SystemTime,
) -> Result<bool, Failure> {
    with_tenant(client, tenant, |tx| {
        let inserted = tx.query(
            "INSERT INTO module_records (tenant_id, module, id, payload, created_at, updated_at)
           VALUES (current_setting('app.tenant_id', true), $1, $2, $3::jsonb, $4, $4)
           ON CONFLICT DO NOTHING RETURNING id",
            &[&module, &id, &payload_json(payload), &at],
        )?;
        if inserted.is_empty() {
            return Ok(false);
        }
        append_audit(tx, at, module, Some(id), note.action, note.detail)?;
        Ok(true)
    })
}

/// `RecordStore.importBatch(..., { insertOnly: true })`; returns the rows created.
///
/// # Errors
/// Driver errors.
pub fn import_insert_only(
    client: &mut Client,
    tenant: &str,
    module: &str,
    items: &[(String, Fields)],
    note: &Note<'_>,
    at: SystemTime,
) -> Result<usize, Failure> {
    with_tenant(client, tenant, |tx| {
        // Repeated ids fold to the first (insert-only), in first-seen order.
        let mut folded: Vec<(&str, &Fields)> = Vec::new();
        for (id, payload) in items {
            if !folded.iter().any(|(known, _)| known == id) {
                folded.push((id, payload));
            }
        }
        let mut created = 0;
        let mut updated = 0;
        for chunk in folded.chunks(IMPORT_CHUNK) {
            let rows: Vec<Value> = chunk
                .iter()
                .map(|(id, payload)| {
                    let mut row = Map::new();
                    row.insert("id".into(), Value::String((*id).to_owned()));
                    row.insert("payload".into(), payload_json(payload));
                    Value::Object(row)
                })
                .collect();
            let written = tx.query(
                "INSERT INTO module_records (tenant_id, module, id, payload, created_at, updated_at)
           SELECT current_setting('app.tenant_id', true), $1, x.id, x.payload, $3, $3
           FROM jsonb_to_recordset($2::jsonb) AS x(id text, payload jsonb)
           ON CONFLICT (tenant_id, module, id) DO NOTHING
           RETURNING (xmax = 0) AS inserted",
                &[&module, &Value::Array(rows), &at],
            )?;
            for row in &written {
                if row.try_get::<_, bool>(0)? {
                    created += 1;
                } else {
                    updated += 1;
                }
            }
        }
        if created + updated > 0 {
            append_audit(tx, at, module, None, note.action, note.detail)?;
        }
        Ok(created)
    })
}
