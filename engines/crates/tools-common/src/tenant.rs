//! The tenant transaction (`apps/api/src/platform/database/tenant-transaction.ts`, ADR 0003).
//!
//! Tools run outside a request, so the actor is empty and the clearance `full`, as in TypeScript.

use postgres::{Client, Transaction};

/// A tenant transaction failed.
#[derive(Debug)]
pub enum TenantError {
    /// Empty tenant id or a NUL character (Node throws a plain `Error` before any work runs).
    Invalid(&'static str),
    /// The driver failed.
    Driver(postgres::Error),
}

impl std::fmt::Display for TenantError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Invalid(message) => f.write_str(message),
            Self::Driver(error) => write!(f, "{error}"),
        }
    }
}

impl std::error::Error for TenantError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Invalid(_) => None,
            Self::Driver(error) => Some(error),
        }
    }
}

impl From<postgres::Error> for TenantError {
    fn from(error: postgres::Error) -> Self {
        Self::Driver(error)
    }
}

/// An `E'…'` literal with backslashes and quotes doubled.
fn literal(value: &str) -> Result<String, TenantError> {
    if value.contains('\0') {
        return Err(TenantError::Invalid(
            "Tenant settings cannot contain NUL characters",
        ));
    }
    Ok(format!(
        "E'{}'",
        value.replace('\\', "\\\\").replace('\'', "''")
    ))
}

/// The single statement that enters a tenant: settings and the `sipges_tenant` role.
///
/// # Errors
/// An empty tenant id or one with NUL.
pub fn tenant_statement(tenant_id: &str) -> Result<String, TenantError> {
    if tenant_id.is_empty() {
        return Err(TenantError::Invalid("Tenant id is required"));
    }
    Ok(format!(
        "SELECT set_config('app.tenant_id', {}, true),
            set_config('app.actor', {}, true),
            set_config('app.clearance', {}, true),
            set_config('role', 'sipges_tenant', true)",
        literal(tenant_id)?,
        literal("")?,
        literal("full")?
    ))
}

/// Runs `work` in one transaction scoped to `tenant_id`; commits only when it succeeds.
///
/// # Errors
/// An invalid tenant id (nothing runs), the driver's error, or `work`'s.
pub fn with_tenant<T, E>(
    client: &mut Client,
    tenant_id: &str,
    work: impl FnOnce(&mut Transaction<'_>) -> Result<T, E>,
) -> Result<T, E>
where
    E: From<TenantError>,
{
    let statement = tenant_statement(tenant_id).map_err(E::from)?;
    let mut tx = client
        .transaction()
        .map_err(|e| E::from(TenantError::Driver(e)))?;
    tx.batch_execute(&statement)
        .map_err(|e| E::from(TenantError::Driver(e)))?;
    let value = work(&mut tx)?;
    tx.commit().map_err(|e| E::from(TenantError::Driver(e)))?;
    Ok(value)
}

/// `appendAudit`: one audit row in the caller's tenant transaction.
///
/// # Errors
/// The driver's error.
pub fn append_audit(
    tx: &mut Transaction<'_>,
    at: std::time::SystemTime,
    module: &str,
    record_id: Option<&str>,
    action: &str,
    detail: &str,
) -> Result<(), postgres::Error> {
    tx.execute(
        "INSERT INTO audit (tenant_id, ts, module, record_id, action, detail)
         VALUES (current_setting('app.tenant_id', true), $1, $2, $3, $4, $5)",
        &[&at, &module, &record_id, &action, &detail],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quotes_settings_like_typescript() {
        let statement = tenant_statement("A/B'\\").unwrap_or_default();
        assert!(statement.contains("set_config('app.tenant_id', E'A/B''\\\\', true)"));
        assert!(statement.contains("set_config('app.clearance', E'full', true)"));
        assert!(tenant_statement("").is_err());
        assert!(tenant_statement("a\0").is_err());
    }
}
