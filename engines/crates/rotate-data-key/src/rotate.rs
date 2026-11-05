//! `rotate.ts`: read-only preflight over every unit, then (with `apply`) one transaction per unit
//! with the rows locked, re-encryption, a check that each value opens with the new key, commit.

use postgres::types::ToSql;
use postgres::{Client, Transaction};
use serde_json::{Map, Value, json};
use sipges_tools_common::tenant::{TenantError, with_tenant};

use crate::cipher::Cipher;

/// A stop; `message` is what TypeScript prints after `Rotation stopped: `.
#[derive(Debug)]
pub struct Failure(pub String);

impl From<postgres::Error> for Failure {
    fn from(error: postgres::Error) -> Self {
        // postgres.js PostgresError.message is the server's message.
        Self(
            error
                .as_db_error()
                .map_or_else(|| error.to_string(), |db| db.message().to_owned()),
        )
    }
}

impl From<TenantError> for Failure {
    fn from(error: TenantError) -> Self {
        match error {
            TenantError::Driver(e) => e.into(),
            TenantError::Invalid(message) => Self(message.to_owned()),
        }
    }
}

/// One sealed column (`TARGETS`).
#[derive(Clone, Copy, Debug)]
pub struct Target {
    /// Table.
    pub table: &'static str,
    /// Sealed column.
    pub column: &'static str,
    /// Primary key column.
    pub id: &'static str,
    /// Whether rows live under a tenant's RLS scope.
    pub tenant_owned: bool,
}

/// Every column sealed with `SIPGES_DATA_KEY`, as in `rotate.ts`.
pub const TARGETS: [Target; 2] = [
    Target {
        table: "users",
        column: "totp_secret_sealed",
        id: "username",
        tenant_owned: false,
    },
    Target {
        table: "integration_channels",
        column: "sealed_config",
        id: "id",
        tenant_owned: true,
    },
];

/// `ColumnReport`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ColumnReport {
    /// Table.
    pub table: &'static str,
    /// Column.
    pub column: &'static str,
    /// `global` or the tenant id.
    pub scope: String,
    /// Non-null values.
    pub total: usize,
    /// Open with the new key.
    pub current: usize,
    /// Open with the old key only.
    pub stale: usize,
    /// Open with neither.
    pub unreadable: usize,
    /// Rewritten under the new key.
    pub rewritten: usize,
    /// Primary keys of unreadable values.
    pub unreadable_ids: Vec<String>,
}

/// `RotationReport`.
#[derive(Debug)]
pub struct Report {
    /// Whether this was `--apply`.
    pub apply: bool,
    /// No unreadable value.
    pub ok: bool,
    /// One per unit.
    pub columns: Vec<ColumnReport>,
    /// Why the run aborted.
    pub problem: Option<&'static str>,
}

impl Report {
    fn mode(&self) -> &'static str {
        if self.apply { "apply" } else { "dry-run" }
    }

    /// `JSON.stringify(report, null, 2)` key order.
    #[must_use]
    pub fn to_json(&self) -> Value {
        let columns: Vec<Value> = self
            .columns
            .iter()
            .map(|c| {
                let mut o = Map::new();
                o.insert("table".into(), json!(c.table));
                o.insert("column".into(), json!(c.column));
                o.insert("scope".into(), json!(c.scope));
                o.insert("total".into(), json!(c.total));
                o.insert("current".into(), json!(c.current));
                o.insert("stale".into(), json!(c.stale));
                o.insert("unreadable".into(), json!(c.unreadable));
                o.insert("rewritten".into(), json!(c.rewritten));
                o.insert("unreadableIds".into(), json!(c.unreadable_ids));
                Value::Object(o)
            })
            .collect();
        let mut o = Map::new();
        o.insert("mode".into(), json!(self.mode()));
        o.insert("ok".into(), json!(self.ok));
        o.insert("columns".into(), Value::Array(columns));
        if let Some(problem) = self.problem {
            o.insert("problem".into(), json!(problem));
        }
        Value::Object(o)
    }

    /// `summarize`.
    #[must_use]
    pub fn summarize(&self) -> String {
        let mut lines = vec![format!("SIPGES_DATA_KEY rotation ({})", self.mode())];
        for c in &self.columns {
            let ids = if c.unreadable_ids.is_empty() {
                String::new()
            } else {
                format!(" (unreadable: {})", c.unreadable_ids.join(", "))
            };
            lines.push(format!(
                "  {}.{} [{}]: total {}, current {}, stale {}, unreadable {}, rewritten {}{ids}",
                c.table, c.column, c.scope, c.total, c.current, c.stale, c.unreadable, c.rewritten
            ));
        }
        let stale: usize = self.columns.iter().map(|c| c.stale).sum();
        if let Some(problem) = self.problem {
            lines.push(format!("ABORTED: {problem}"));
        } else if !self.apply {
            lines.push(if stale > 0 {
                format!("{stale} value(s) would be re-encrypted; run with --apply")
            } else {
                "Nothing to rotate".into()
            });
        } else {
            lines.push("Done: every sealed value opens with the new key".into());
        }
        lines.join("\n")
    }
}

/// A primary key as read: `username` text or `id` integer.
#[derive(Clone, Debug)]
enum Id {
    Text(String),
    Int(i32),
}

impl Id {
    fn label(&self) -> String {
        match self {
            Self::Text(text) => text.clone(),
            Self::Int(n) => n.to_string(),
        }
    }

    fn param(&self) -> &(dyn ToSql + Sync) {
        match self {
            Self::Text(text) => text,
            Self::Int(n) => n,
        }
    }
}

fn select_sealed(
    tx: &mut Transaction<'_>,
    target: Target,
    lock: bool,
) -> Result<Vec<(Id, String)>, Failure> {
    let rows = tx.query(
        &format!(
            "SELECT {id} AS id, {column} AS sealed FROM {table}
     WHERE {column} IS NOT NULL ORDER BY {id}{lock}",
            id = target.id,
            column = target.column,
            table = target.table,
            lock = if lock { " FOR UPDATE" } else { "" }
        ),
        &[],
    )?;
    rows.iter()
        .map(|row| {
            let id = if target.tenant_owned {
                Id::Int(row.try_get(0)?)
            } else {
                Id::Text(row.try_get(0)?)
            };
            Ok((id, row.try_get(1)?))
        })
        .collect()
}

/// The new and the old key's ciphers.
pub struct Ciphers {
    /// New key.
    pub fresh: Cipher,
    /// Old key.
    pub old: Cipher,
}

fn process_unit(
    tx: &mut Transaction<'_>,
    target: Target,
    scope: &str,
    ciphers: &Ciphers,
    apply: bool,
) -> Result<ColumnReport, Failure> {
    let rows = select_sealed(tx, target, apply)?;
    let mut current = 0;
    let mut stale: Vec<(Id, String, String)> = Vec::new();
    let mut unreadable_ids = Vec::new();
    for (id, sealed) in &rows {
        if ciphers.fresh.open(sealed).is_some() {
            current += 1;
            continue;
        }
        match ciphers.old.open(sealed) {
            Some(plaintext) => stale.push((id.clone(), sealed.clone(), plaintext)),
            None => unreadable_ids.push(id.label()),
        }
    }
    let mut rewritten = 0;
    if apply {
        if !unreadable_ids.is_empty() {
            return Err(Failure(format!(
                "{}.{} ({scope}) has unreadable values",
                target.table, target.column
            )));
        }
        for (id, sealed, plaintext) in &stale {
            let check = || {
                Failure(format!(
                    "Re-encryption check failed in {}.{}",
                    target.table, target.column
                ))
            };
            let resealed = ciphers.fresh.seal(plaintext).map_err(|_| check())?;
            if ciphers.fresh.open(&resealed).as_deref() != Some(plaintext.as_str()) {
                return Err(check());
            }
            let updated = tx.query(
                &format!(
                    "UPDATE {table} SET {column} = $1
         WHERE {id} = $2 AND {column} = $3 RETURNING {id}",
                    table = target.table,
                    column = target.column,
                    id = target.id
                ),
                &[&resealed, id.param(), sealed],
            )?;
            if updated.len() != 1 {
                return Err(Failure(format!(
                    "{}.{} changed during rotation; re-run",
                    target.table, target.column
                )));
            }
            rewritten += 1;
        }
        for (_, sealed) in select_sealed(tx, target, false)? {
            if ciphers.fresh.open(&sealed).is_none() {
                return Err(Failure(format!(
                    "{}.{} does not open with the new key",
                    target.table, target.column
                )));
            }
        }
    }
    Ok(ColumnReport {
        table: target.table,
        column: target.column,
        scope: scope.to_owned(),
        total: rows.len(),
        current,
        stale: stale.len(),
        unreadable: unreadable_ids.len(),
        rewritten,
        unreadable_ids,
    })
}

fn in_unit(
    client: &mut Client,
    target: Target,
    scope: &str,
    work: impl FnOnce(&mut Transaction<'_>) -> Result<ColumnReport, Failure>,
) -> Result<ColumnReport, Failure> {
    if target.tenant_owned {
        return with_tenant(client, scope, work);
    }
    let mut tx = client.transaction()?;
    let report = work(&mut tx)?;
    tx.commit()?;
    Ok(report)
}

/// `rotateDataKey`.
///
/// # Errors
/// Equal keys, driver errors and the unit checks; the failing unit is rolled back.
pub fn rotate(
    client: &mut Client,
    old_key: &[u8; 32],
    new_key: &[u8; 32],
    apply: bool,
) -> Result<Report, Failure> {
    if old_key == new_key {
        return Err(Failure("The old and new data keys must differ".into()));
    }
    let cipher = |key: &[u8; 32]| {
        Cipher::new(key).map_err(|_| Failure("SIPGES_DATA_KEY must decode to 32 bytes".into()))
    };
    let ciphers = Ciphers {
        fresh: cipher(new_key)?,
        old: cipher(old_key)?,
    };
    let tenants: Vec<String> = client
        .query("SELECT tenant_id FROM tenants ORDER BY tenant_id", &[])?
        .iter()
        .map(|row| row.try_get(0))
        .collect::<Result<_, _>>()?;
    let mut units: Vec<(Target, String)> = Vec::new();
    for target in TARGETS {
        if target.tenant_owned {
            units.extend(tenants.iter().map(|t| (target, t.clone())));
        } else {
            units.push((target, "global".into()));
        }
    }
    let mut preflight = Vec::new();
    for (target, scope) in &units {
        preflight.push(in_unit(client, *target, scope, |tx| {
            process_unit(tx, *target, scope, &ciphers, false)
        })?);
    }
    if preflight.iter().any(|c| c.unreadable > 0) {
        return Ok(Report {
            apply,
            ok: false,
            columns: preflight,
            problem: Some(
                "Some values cannot be opened with either key (wrong SIPGES_DATA_KEY_PREVIOUS?); nothing was written",
            ),
        });
    }
    if !apply {
        return Ok(Report {
            apply,
            ok: true,
            columns: preflight,
            problem: None,
        });
    }
    let mut applied = Vec::new();
    for (target, scope) in &units {
        applied.push(in_unit(client, *target, scope, |tx| {
            process_unit(tx, *target, scope, &ciphers, true)
        })?);
    }
    Ok(Report {
        apply,
        ok: true,
        columns: applied,
        problem: None,
    })
}
