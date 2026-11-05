//! The API migrator (`apps/api/src/platform/database/migrator.ts`) over the SQL files embedded at
//! build time: each pending migration in its own transaction under the shared advisory lock.

use postgres::Client;

/// One `NNNN_name.sql` file.
#[derive(Debug)]
pub struct Migration {
    /// File name without `.sql`.
    pub version: &'static str,
    /// The file's SQL, run with the simple protocol (several statements).
    pub sql: &'static str,
}

include!(concat!(env!("OUT_DIR"), "/migrations.rs"));

/// `MIGRATION_LOCK_KEY`, shared by every SIPGES instance.
const MIGRATION_LOCK_KEY: i64 = 7_361_524_002;

/// A failed migration; Node reports `new Error('Migration <v> failed')`.
#[derive(Debug)]
pub struct MigrationError {
    /// The failing version, or `None` while creating `schema_migrations`.
    pub version: Option<&'static str>,
    /// The driver error.
    pub cause: postgres::Error,
}

impl std::fmt::Display for MigrationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self.version {
            Some(version) => write!(f, "Migration {version} failed"),
            None => write!(f, "{}", self.cause),
        }
    }
}

impl std::error::Error for MigrationError {}

/// Applies the pending embedded migrations; returns the applied versions.
///
/// # Errors
/// A failed statement: the failing migration's transaction rolls back and later ones never run.
pub fn migrate(client: &mut Client) -> Result<Vec<&'static str>, MigrationError> {
    let bootstrap = |client: &mut Client| -> Result<(), postgres::Error> {
        let mut tx = client.transaction()?;
        tx.execute("SELECT pg_advisory_xact_lock($1)", &[&MIGRATION_LOCK_KEY])?;
        tx.batch_execute(
            "CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
        )?;
        tx.commit()
    };
    bootstrap(client).map_err(|cause| MigrationError {
        version: None,
        cause,
    })?;
    let done: Vec<String> = client
        .query("SELECT version FROM schema_migrations", &[])
        .map_err(|cause| MigrationError {
            version: None,
            cause,
        })?
        .iter()
        .map(|row| row.get(0))
        .collect();
    let mut applied = Vec::new();
    for migration in MIGRATIONS {
        if done.iter().any(|version| version == migration.version) {
            continue;
        }
        let run = |client: &mut Client| -> Result<bool, postgres::Error> {
            let mut tx = client.transaction()?;
            tx.execute("SELECT pg_advisory_xact_lock($1)", &[&MIGRATION_LOCK_KEY])?;
            let existing = tx.query(
                "SELECT 1 FROM schema_migrations WHERE version = $1",
                &[&migration.version],
            )?;
            if !existing.is_empty() {
                tx.commit()?;
                return Ok(false);
            }
            tx.batch_execute(migration.sql)?;
            tx.execute(
                "INSERT INTO schema_migrations (version) VALUES ($1)",
                &[&migration.version],
            )?;
            tx.commit()?;
            Ok(true)
        };
        if run(client).map_err(|cause| MigrationError {
            version: Some(migration.version),
            cause,
        })? {
            applied.push(migration.version);
        }
    }
    Ok(applied)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embeds_sorted_migrations() {
        assert!(MIGRATIONS.len() > 30);
        assert!(
            MIGRATIONS
                .windows(2)
                .all(|w| matches!(w, [a, b] if a.version < b.version))
        );
        assert_eq!(MIGRATIONS.first().map(|m| m.version), Some("0001_identity"));
    }
}
