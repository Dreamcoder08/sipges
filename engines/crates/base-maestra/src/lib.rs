//! Rust port of `apps/api/src/tools/base-maestra` (T43): plans and loads the prototype's Base
//! Maestra into one tenant, insert-only, one audited transaction per module. Dry run by default.

pub mod json;
pub mod plan;
pub mod run;
