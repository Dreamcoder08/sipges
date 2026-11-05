//! `runReviewMaterialize` and `materializeApprovedReviews`.

use std::time::SystemTime;

use postgres::Client;
use serde_json::{Map, Value, json};
use sipges_tools_common::tenant::TenantError;

use crate::records::{self, Fields, MAX_IMPORT_ROWS, Problem};
use crate::review::{self, InvalidDate, REVIEW_SOURCE};
use crate::store::{self, Note};

/// Page size of the approved items and of each records batch.
pub const PAGE_SIZE: usize = 500;

/// Anything that stops a run; the CLI prints only its JavaScript error name.
#[derive(Debug)]
pub enum Failure {
    /// Driver error.
    Driver(postgres::Error),
    /// Invalid tenant id for the tenant transaction.
    Tenant(TenantError),
    /// A date JavaScript cannot represent.
    Range(InvalidDate),
}

impl std::fmt::Display for Failure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Driver(e) => write!(f, "{e}"),
            Self::Tenant(e) => write!(f, "{e}"),
            Self::Range(e) => write!(f, "{e}"),
        }
    }
}

impl std::error::Error for Failure {}

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
    /// The `error.name` the TypeScript CLI prints.
    #[must_use]
    pub fn js_name(&self) -> &'static str {
        match self {
            Self::Driver(e) if e.as_db_error().is_some() => "PostgresError",
            Self::Driver(_) | Self::Tenant(_) => "Error",
            Self::Range(_) => "RangeError",
        }
    }
}

/// Per-module counts.
#[derive(Debug, PartialEq, Eq)]
pub struct ModuleReport {
    /// Records slug.
    pub module: String,
    /// Created (or to create, in a dry run).
    pub nuevos: usize,
    /// Already stored.
    pub ya_existentes: usize,
}

/// `MaterializeReport`.
#[derive(Debug, PartialEq, Eq)]
pub struct TenantReport {
    /// Tenant id.
    pub tenant: String,
    /// Approved items read.
    pub approved: usize,
    /// Modules by slug.
    pub modules: Vec<ModuleReport>,
    /// Problems, prefixed with the module slug.
    pub problems: Vec<String>,
}

/// `ReviewMaterializeRun`.
#[derive(Debug)]
pub struct RunReport {
    /// Whether `--apply` was given.
    pub applied: bool,
    /// One report per tenant, by tenant id.
    pub tenants: Vec<TenantReport>,
    /// A requested scope that does not exist.
    pub missing: Vec<String>,
}

impl RunReport {
    /// The object `JSON.stringify(run, null, 2)` prints, in the same key order.
    #[must_use]
    pub fn to_json(&self) -> Value {
        let tenants: Vec<Value> = self
            .tenants
            .iter()
            .map(|t| {
                let modules: Vec<Value> = t
                    .modules
                    .iter()
                    .map(|m| json!({ "module": m.module, "nuevos": m.nuevos, "ya_existentes": m.ya_existentes }))
                    .collect();
                let mut object = Map::new();
                object.insert("tenant".into(), Value::String(t.tenant.clone()));
                object.insert("approved".into(), json!(t.approved));
                object.insert("modules".into(), Value::Array(modules));
                object.insert("problems".into(), json!(t.problems));
                Value::Object(object)
            })
            .collect();
        let mut object = Map::new();
        object.insert("applied".into(), Value::Bool(self.applied));
        object.insert("tenants".into(), Value::Array(tenants));
        object.insert("missing".into(), json!(self.missing));
        Value::Object(object)
    }
}

/// `RecordsService.createMissing` through `reviewRecordsPort` (problems as `fila N: …`).
fn create_missing(
    client: &mut Client,
    tenant: &str,
    slug: &str,
    items: &[(String, Fields)],
    dry_run: bool,
    now: &dyn Fn() -> SystemTime,
) -> Result<(usize, usize, Vec<String>), Failure> {
    let Some(module) = records::module_for_slug(slug) else {
        return Ok((0, 0, vec![format!("Módulo desconocido: {slug}")]));
    };
    let as_port = |problems: Vec<Problem>| -> Vec<String> {
        problems
            .into_iter()
            .map(|p| format!("fila {}: {}", p.row, p.message))
            .collect()
    };
    if items.len() > MAX_IMPORT_ROWS {
        return Ok((
            0,
            0,
            as_port(vec![Problem {
                row: 0,
                message: format!("Máximo {MAX_IMPORT_ROWS} filas por importación"),
            }]),
        ));
    }
    let mut counter: u64 = 0;
    let mut hex = |length: usize| {
        let value = format!("{counter:0length$x}");
        counter += 1;
        value
    };
    let rows: Vec<Fields> = items.iter().map(|(_, fields)| fields.clone()).collect();
    let (plan, mut problems) = records::plan_import(module, &rows, &mut hex);
    let mut seen: Vec<&str> = Vec::new();
    for (index, (id, _)) in items.iter().enumerate() {
        if !records::is_lookupable_id(id) || id.is_empty() {
            problems.push(Problem {
                row: index + 1,
                message: "Código de registro inválido".into(),
            });
        } else if seen.contains(&id.as_str()) {
            problems.push(Problem {
                row: index + 1,
                message: format!("El código {id} está repetido"),
            });
        }
        seen.push(id);
    }
    if !problems.is_empty() {
        // Array.prototype.sort is stable.
        problems.sort_by_key(|p| p.row);
        return Ok((0, 0, as_port(problems)));
    }
    let planned: Vec<(String, Fields)> = plan
        .into_iter()
        .map(|entry| {
            let id = items
                .get(entry.row - 1)
                .map_or(entry.id, |(id, _)| id.clone());
            (id, entry.payload)
        })
        .collect();
    let present = if planned.is_empty() {
        std::collections::HashSet::new()
    } else {
        let ids: Vec<&str> = planned.iter().map(|(id, _)| id.as_str()).collect();
        store::existing(client, tenant, module, &ids)?
    };
    let fresh: Vec<(String, Fields)> = planned
        .iter()
        .filter(|(id, _)| !present.contains(id))
        .cloned()
        .collect();
    if dry_run || fresh.is_empty() {
        return Ok((fresh.len(), planned.len() - fresh.len(), Vec::new()));
    }
    // options.source.trim().slice(0, 120) || 'origen sin nombre'
    let source =
        sipges_tools_common::js::slice_utf16(sipges_tools_common::js::trim(REVIEW_SOURCE), 120);
    let source = if source.is_empty() {
        "origen sin nombre"
    } else {
        source
    };
    let created = if let [(id, payload)] = fresh.as_slice() {
        let detail = format!("Registro creado desde {source}");
        let note = Note {
            action: "CREATE",
            detail: &detail,
        };
        usize::from(store::create(
            client,
            tenant,
            module,
            id,
            payload,
            &note,
            now(),
        )?)
    } else {
        let detail = format!("{} registros creados desde {source}", fresh.len());
        let note = Note {
            action: "IMPORT",
            detail: &detail,
        };
        store::import_insert_only(client, tenant, module, &fresh, &note, now())?
    };
    Ok((created, planned.len() - created, Vec::new()))
}

/// `materializeApprovedReviews` for one tenant.
///
/// # Errors
/// Driver errors and dates JavaScript cannot represent.
pub fn materialize_tenant(
    client: &mut Client,
    tenant: &str,
    apply: bool,
    now: &dyn Fn() -> SystemTime,
) -> Result<TenantReport, Failure> {
    let project = review::project_of(tenant).to_owned();
    // A Map keeps first-insertion order; modules are then sorted by slug.
    let mut by_module: Vec<(String, Vec<(String, Fields)>)> = Vec::new();
    let mut approved = 0;
    let mut after_id = String::new();
    loop {
        let page = store::approved(
            client,
            tenant,
            &after_id,
            i64::try_from(PAGE_SIZE).unwrap_or(i64::MAX),
        )?;
        for item in &page {
            let module = review::review_target(&item.theme);
            let fields = review::review_record_fields(item, &project).map_err(Failure::Range)?;
            let entry = (review::review_record_id(&item.id), fields);
            if let Some((_, rows)) = by_module.iter_mut().find(|(m, _)| m == module) {
                rows.push(entry);
            } else {
                by_module.push((module.to_owned(), vec![entry]));
            }
        }
        approved += page.len();
        match page.last() {
            Some(last) if page.len() >= PAGE_SIZE => last.id.clone_into(&mut after_id),
            _ => break,
        }
    }
    // localeCompare over the fixed ASCII slugs equals byte order.
    by_module.sort_by(|(a, _), (b, _)| a.cmp(b));
    let mut modules = Vec::new();
    let mut problems = Vec::new();
    for (module, rows) in &by_module {
        let mut nuevos = 0;
        let mut existentes = 0;
        for batch in rows.chunks(PAGE_SIZE) {
            let (created, existing, found) =
                create_missing(client, tenant, module, batch, !apply, now)?;
            nuevos += created;
            existentes += existing;
            problems.extend(found.into_iter().map(|p| format!("{module}: {p}")));
        }
        modules.push(ModuleReport {
            module: module.clone(),
            nuevos,
            ya_existentes: existentes,
        });
    }
    Ok(TenantReport {
        tenant: tenant.to_owned(),
        approved,
        modules,
        problems,
    })
}

/// `runReviewMaterialize`.
///
/// # Errors
/// Driver errors and dates JavaScript cannot represent.
pub fn run(
    client: &mut Client,
    apply: bool,
    scope: Option<&str>,
    now: &dyn Fn() -> SystemTime,
) -> Result<RunReport, Failure> {
    let tenants: Vec<String> = client
        .query(
            "SELECT tenant_id FROM tenants WHERE ($1::text IS NULL OR tenant_id = $1)
        ORDER BY tenant_id",
            &[&scope],
        )?
        .iter()
        .map(|row| row.try_get(0))
        .collect::<Result<_, _>>()?;
    let mut reports = Vec::new();
    for tenant in &tenants {
        reports.push(materialize_tenant(client, tenant, apply, now)?);
    }
    let missing = match scope {
        Some(scope) if !scope.is_empty() && tenants.is_empty() => vec![scope.to_owned()],
        _ => Vec::new(),
    };
    Ok(RunReport {
        applied: apply,
        tenants: reports,
        missing,
    })
}
