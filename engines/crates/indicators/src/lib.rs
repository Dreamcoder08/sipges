//! SIPGES indicators v0.4 and IRSA engine: a byte-for-byte port of the TypeScript engine in
//! `apps/api/src/contexts/indicators/domain`, including its Python-compatible rounding and text
//! coercion. Pure computation, no I/O; [`compute`] is the JSON ABI every host calls.

pub mod api;
pub mod defaults;
pub mod error;
pub mod indicators;
pub mod irsa;
pub mod js;
pub mod python;
pub mod records;

pub use api::{OPERATIONS, compute};
pub use error::EngineError;
