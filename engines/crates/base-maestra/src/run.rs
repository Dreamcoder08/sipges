//! `run.ts` with the record store's `existing` and insert-only `importBatch`
//! (`contexts/records/infrastructure/sql-record-store.ts`).

use std::collections::HashSet;
use std::time::SystemTime;

use postgres::Client;
use serde_json::{Map, Value, json};
use sipges_tools_common::tenant::{TenantError, append_audit, with_tenant};

use crate::json::{self, Json};
use crate::plan::{Object, plan};

/// Records per insert statement (`IMPORT_CHUNK`).
const IMPORT_CHUNK: usize = 500;

/// A stop; the CLI prints only the JavaScript error name.
#[derive(Debug)]
pub enum Failure {
    /// Driver error.
    Driver(postgres::Error),
    /// Invalid tenant id.
    Tenant(TenantError),
    /// A row too deep for TypeScript's recursion (`RangeError`).
    TooDeep,
}

impl From<postgres::Error> for Failure {
    fn from(error: postgres::Error) -> Self {
        Self::Driver(error)
    }
}

impl From<TenantError> for Failure {
    fn from(error: TenantError) -> Self {
        match error {
            TenantError::Driver(e) => Self::Driver(e),
            other @ TenantError::Invalid(_) => Self::Tenant(other),
        }
    }
}

impl Failure {
    /// `error.name` in TypeScript.
    #[must_use]
    pub fn js_name(&self) -> &'static str {
        match self {
            Self::Driver(e) if e.as_db_error().is_some() => "PostgresError",
            Self::TooDeep => "RangeError",
            _ => "Error",
        }
    }
}

/// One module of the report.
#[derive(Debug)]
pub struct ModuleReport {
    /// Stored module name.
    pub module: &'static str,
    /// Rows in the file.
    pub en_archivo: usize,
    /// New records (created, or to create in a dry run).
    pub nuevos: usize,
    /// Valid rows already stored.
    pub ya_existentes: usize,
}

/// `BaseMaestraReport`.
#[derive(Debug)]
pub struct Report {
    /// `apply` and no problem.
    pub applied: bool,
    /// Modules in file order.
    pub modules: Vec<ModuleReport>,
    /// Codes and positions only.
    pub problems: Vec<String>,
}

impl Report {
    /// The object `JSON.stringify(report, null, 2)` prints.
    #[must_use]
    pub fn to_json(&self) -> Value {
        let modules: Vec<Value> = self
            .modules
            .iter()
            .map(|m| {
                let mut o = Map::new();
                o.insert("module".into(), json!(m.module));
                o.insert("en_archivo".into(), json!(m.en_archivo));
                o.insert("nuevos".into(), json!(m.nuevos));
                o.insert("ya_existentes".into(), json!(m.ya_existentes));
                Value::Object(o)
            })
            .collect();
        let mut o = Map::new();
        o.insert("applied".into(), json!(self.applied));
        o.insert("modules".into(), Value::Array(modules));
        o.insert("problems".into(), json!(self.problems));
        Value::Object(o)
    }
}

fn existing(
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

/// `importBatch(..., { insertOnly: true })` with the Base Maestra detail rewritten to the count
/// actually created.
fn import_insert_only(
    client: &mut Client,
    tenant: &str,
    module: &str,
    items: &[&(String, Object)],
    detail: &str,
    at: SystemTime,
) -> Result<usize, Failure> {
    with_tenant(client, tenant, |tx| {
        let mut seen = HashSet::new();
        let folded: Vec<&(String, Object)> = items
            .iter()
            .copied()
            .filter(|item| seen.insert(item.0.as_str()))
            .collect();
        let (mut created, mut updated) = (0_usize, 0_usize);
        for chunk in folded.chunks(IMPORT_CHUNK) {
            let rows: Vec<Json> = chunk
                .iter()
                .map(|(id, payload)| {
                    Json::Obj(vec![
                        ("id".into(), Json::Str(id.clone())),
                        ("payload".into(), Json::Obj(payload.clone())),
                    ])
                })
                .collect();
            // JSON.stringify(rows): JavaScript number spelling and key order.
            let text = json::stringify(&Json::Arr(rows));
            let written = tx.query(
                "INSERT INTO module_records (tenant_id, module, id, payload, created_at, updated_at)
           SELECT current_setting('app.tenant_id', true), $1, x.id, x.payload, $3, $3
           FROM jsonb_to_recordset($2::text::jsonb) AS x(id text, payload jsonb)
           ON CONFLICT (tenant_id, module, id) DO NOTHING
           RETURNING (xmax = 0) AS inserted",
                &[&module, &text, &at],
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
            // detail.replace(/^Base Maestra: \d+ registros nuevos/, …)
            let detail = rewrite_count(detail, created);
            append_audit(tx, at, module, None, "IMPORT", &detail)?;
        }
        Ok(created)
    })
}

fn rewrite_count(detail: &str, created: usize) -> String {
    let Some(rest) = detail.strip_prefix("Base Maestra: ") else {
        return detail.to_owned();
    };
    let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
    match rest.get(digits..) {
        Some(tail) if digits > 0 && tail.starts_with(" registros nuevos") => {
            format!("Base Maestra: {created}{tail}")
        }
        _ => detail.to_owned(),
    }
}

/// `importBaseMaestra`.
///
/// # Errors
/// Driver errors.
pub fn import(
    client: &mut Client,
    tenant: &str,
    seed: &Json,
    apply: bool,
    source: &str,
    now: &dyn Fn() -> SystemTime,
) -> Result<Report, Failure> {
    let plan = plan(seed).map_err(|_| Failure::TooDeep)?;
    let apply = apply && plan.problems.is_empty();
    let mut modules = Vec::new();
    for planned in &plan.modules {
        let present = if planned.items.is_empty() {
            HashSet::new()
        } else {
            let ids: Vec<&str> = planned.items.iter().map(|(id, _)| id.as_str()).collect();
            existing(client, tenant, planned.module, &ids)?
        };
        let fresh: Vec<&(String, Object)> = planned
            .items
            .iter()
            .filter(|(id, _)| !present.contains(id))
            .collect();
        let mut created = fresh.len();
        if apply && !fresh.is_empty() {
            let detail = format!(
                "Base Maestra: {} registros nuevos desde {source}",
                fresh.len()
            );
            created = import_insert_only(client, tenant, planned.module, &fresh, &detail, now())?;
        }
        modules.push(ModuleReport {
            module: planned.module,
            en_archivo: planned.in_file,
            nuevos: created,
            ya_existentes: planned.items.len() - created,
        });
    }
    Ok(Report {
        applied: apply,
        modules,
        problems: plan.problems,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rewrites_the_count_like_the_regex() {
        assert_eq!(
            rewrite_count("Base Maestra: 5 registros nuevos desde s.json", 3),
            "Base Maestra: 3 registros nuevos desde s.json"
        );
        assert_eq!(
            rewrite_count("Otro: 5 registros nuevos", 3),
            "Otro: 5 registros nuevos"
        );
    }
}
