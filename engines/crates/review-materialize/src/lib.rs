//! Rust port of `apps/api/src/tools/review-materialize` (T43): creates the records of document
//! review items approved before approvals created them, insert-only under their deterministic
//! `REV-<id>` ids, tenant by tenant. Dry run unless `--apply`.

pub mod records;
pub mod review;
pub mod run;
pub mod store;
