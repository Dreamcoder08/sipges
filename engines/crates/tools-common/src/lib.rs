//! Shared pieces of the SIPGES operator tools ported to Rust (ADR 0032, T43).
//!
//! Each tool keeps the TypeScript tool's flags, output and exit codes; these modules hold what
//! they share: Node's `parseArgs` rules ([`args`]), JavaScript string semantics ([`js`]), the
//! PostgreSQL connection with the API's TLS rule ([`db`]), the API migrator over the embedded SQL
//! files ([`migrate`]), the tenant transaction ([`tenant`]) and `Date` helpers ([`time`]).

pub mod args;
pub mod db;
pub mod env;
pub mod js;
pub mod migrate;
pub mod notice;
pub mod tenant;
pub mod time;
