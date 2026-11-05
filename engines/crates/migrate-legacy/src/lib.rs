//! Rust port of `apps/api/src/tools/migrate-legacy` (ODD go-rust-stack T43, ADR 0032): copies a
//! legacy SIPGES installation (SQLite, JSON settings, uploads) into PostgreSQL and object storage.
//! Dry run by default. Runbook and known differences: docs/migration/data-migration.md.
//!
//! Output holds counts, problem codes and identifiers only, never record contents, password
//! hashes or TOTP secrets, and no failure prints a driver message, which could quote a value.

pub mod js_date;
pub mod json;
pub mod mapping;
pub mod value;
